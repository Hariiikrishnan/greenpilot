import { useState, useEffect } from 'react';
import { api, setActiveOrgId } from './api.js';
import { C, FONT } from './constants.js';
import { useHashRoute } from './hooks/useHashRoute.js';
import { useOrgRole } from './hooks/useOrgRole.js';
import { clearOrgRoleCache } from './hooks/useOrgRole.js';
import LoginGate from './components/LoginGate.jsx';
import SetupWizard from './components/SetupWizard.jsx';
import OnboardingWizard from './components/OnboardingWizard.jsx';
import InviteAcceptPage from './components/InviteAcceptPage.jsx';
import Topbar from './components/Topbar.jsx';
import Sidebar from './components/Sidebar.jsx';
import ChatsPage from './components/ChatsPage.jsx';
import HomePage from './pages/HomePage.jsx';
import ChatbotBuilderPage from './pages/ChatbotBuilderPage.jsx';
import TemplateBuilderPage from './pages/TemplateBuilderPage.jsx';
import ContactsPage from './pages/ContactsPage.jsx';
import BulkMessagePage from './pages/BulkMessagePage.jsx';
import AdminSettingsPage from './pages/AdminSettingsPage.jsx';
import MediaLibraryPage from './pages/MediaLibraryPage.jsx';
import AboutUsPage from './pages/AboutUsPage.jsx';
import PipelinesPage from './pages/PipelinesPage.jsx';
import AiAgentBuilderPage from './pages/AiAgentBuilderPage.jsx';
import { disconnectRealtime } from './realtime/socketClient.js';

const VALID_PAGES = new Set([
  'home', 'chatbot-builder', 'template-builder', 'chats',
  'contacts', 'pipelines', 'bulk-message', 'admin-settings', 'media-library', 'about',
  'ai-agent-builder',
]);

export default function App() {
  const [user, setUser] = useState(null);
  const [checking, setChecking] = useState(true);
  const [setupRequired, setSetupRequired] = useState(false);
  // Server-persisted onboarding gate: null = unknown, true = show wizard.
  const [needsOnboarding, setNeedsOnboarding] = useState(null);
  const [routeParts, navigate, replaceRoute] = useHashRoute();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const page = VALID_PAGES.has(routeParts[0]) ? routeParts[0] : 'home';
  const subParts = routeParts.slice(1);
  const setPage = (p) => navigate(p);
  // Org-manager navigation: owners/admins of the active org may reach
  // admin-settings (tab-level filtering still applies inside the page).
  const orgRole = useOrgRole();
  // Invite links (#/invite/<token>) are valid for signed-in users only — the
  // token (not a client org id) establishes the organization context.
  const inviteToken = routeParts[0] === 'invite' ? routeParts[1] : null;

  // Normalize empty hash to #/home so reload always shows a valid URL
  useEffect(() => {
    if (!routeParts[0]) replaceRoute('home');
  }, [routeParts, replaceRoute]);

  // Page guard: non-admins can only reach pages granted to them (user.pages).
  // admin-settings is allowed if they have any admin-settings:* sub-page —
  // or when they manage the active org (owner/admin), in which case the page
  // itself filters to the setup tabs they may use. Backend endpoints enforce
  // the real authorization; this guard only shapes navigation.
  useEffect(() => {
    if (!user || user.role === 'admin' || !Array.isArray(user.pages)) return;
    const allowed = page === 'admin-settings'
      ? (user.pages.some(p => p.startsWith('admin-settings')) || orgRole?.isManager)
      : user.pages.includes(page);
    if (!allowed) setPage('home');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, user, orgRole]);

  useEffect(() => {
    // Collapse main sidebar by default on automation builder page
    if (page === 'chatbot-builder') {
      setSidebarCollapsed(true);
    }
  }, [page]);

  // After auth, ask the SERVER whether onboarding is still open. Fresh
  // signups always land in the wizard; returning users skip it when their
  // org already completed onboarding. Failures fail OPEN (dashboard) so a
  // pre-migration backend never locks users out of the product.
  const checkOnboarding = (freshSignup = false) => {
    if (freshSignup) { setNeedsOnboarding(true); return; }
    api.settings.overview()
      .then(ov => setNeedsOnboarding(!ov?.onboarding?.completed))
      .catch(() => setNeedsOnboarding(false));
  };

  const handleLogin = (u, opts = {}) => {
    setUser(u);
    checkOnboarding(opts.freshSignup);
  };

  useEffect(() => {
    // First check whether the instance needs first-run setup (no users yet).
    // If so, show the setup wizard; otherwise resume the normal session check.
    api.auth.status()
      .then(({ setupRequired: needed }) => {
        if (needed) { setSetupRequired(true); setChecking(false); return null; }
        return api.auth.me()
          .then(({ user }) => { setUser(user); checkOnboarding(false); })
          .catch(() => setUser(null))
          .finally(() => setChecking(false));
      })
      .catch(() => {
        // status unavailable (DB warming) — fall back to a normal session check.
        api.auth.me()
          .then(({ user }) => { setUser(user); checkOnboarding(false); })
          .catch(() => setUser(null))
          .finally(() => setChecking(false));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleLogout = async () => {
    await api.auth.logout().catch(() => {});
    // Phase 12 session teardown: socket + org hint + onboarding gate + user.
    // Clearing the active-org hint guarantees no previous organization's data
    // (or socket rooms) can linger into the next session on a shared device.
    try { disconnectRealtime(); } catch { /* ignore */ }
    try { setActiveOrgId(null); } catch { /* ignore */ }
    try { clearOrgRoleCache(); } catch { /* ignore */ }
    setUser(null);
    setNeedsOnboarding(null);
    setPage('home');
  };

  if (checking) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: FONT,
        background: C.pageBg,
      }}>
        <div style={{ fontSize: 13, color: C.textMuted, fontWeight: 500 }}>Loading…</div>
      </div>
    );
  }

  if (setupRequired && !user) {
    return <SetupWizard onComplete={(u) => { setSetupRequired(false); handleLogin(u, { freshSignup: true }); }} />;
  }

  if (!user) {
    // Invite links require sign-in first; after login the invite page renders.
    return <LoginGate onLogin={handleLogin} />;
  }

  // Authenticated invite acceptance (token sets org context server-side).
  if (inviteToken) {
    return (
      <InviteAcceptPage
        token={inviteToken}
        onNavigate={setPage}
        onAccepted={() => {
          // Reload the session: membership + page grants changed on accept.
          api.auth.me()
            .then(({ user: fresh }) => { setUser(fresh); })
            .catch(() => {})
            .finally(() => { setNeedsOnboarding(null); checkOnboarding(false); setPage('home'); });
        }}
      />
    );
  }

  // Server-gated onboarding: new customers land here until required setup is
  // genuinely complete. "Skip for now" only hides it for this session view —
  // the server still reports incomplete on next login.
  if (needsOnboarding === null) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: FONT,
        background: C.pageBg,
      }}>
        <div style={{ fontSize: 13, color: C.textMuted, fontWeight: 500 }}>Loading your workspace…</div>
      </div>
    );
  }
  if (needsOnboarding) {
    return (
      <OnboardingWizard
        onNavigate={(p) => { setNeedsOnboarding(false); navigate(p); }}
        onComplete={() => { setNeedsOnboarding(false); setPage('home'); }}
      />
    );
  }

  const renderPage = () => {
    switch (page) {
      case 'home': return <HomePage user={user} onPageChange={setPage} />;
      case 'chats': return <ChatsPage subParts={subParts} navigate={navigate} user={user} />;
      case 'contacts': return <ContactsPage user={user} onNavigate={navigate} />;
      case 'pipelines': return <PipelinesPage user={user} />;
      case 'template-builder': return <TemplateBuilderPage subParts={subParts} navigate={navigate} />;
      case 'media-library': return <MediaLibraryPage />;
      case 'bulk-message': return <BulkMessagePage onNavigate={navigate} />;
      case 'chatbot-builder': return <ChatbotBuilderPage subParts={subParts} navigate={navigate} />;
      case 'ai-agent-builder': return <AiAgentBuilderPage user={user} navigate={navigate} />;
      case 'about': return <AboutUsPage />;
      case 'admin-settings': return <AdminSettingsPage onLogout={handleLogout} onNavigate={setPage} subParts={subParts} navigate={navigate} user={user} />;
      default: return <HomePage user={user} onPageChange={setPage} />;
    }
  };

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      fontFamily: FONT,
      background: C.pageBg,
    }}>
      <Topbar user={user} onLogout={handleLogout} onNavigate={setPage} />
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {page !== 'admin-settings' && (
          <Sidebar
            activePage={page}
            onPageChange={setPage}
            collapsed={sidebarCollapsed}
            setCollapsed={setSidebarCollapsed}
            user={user}
          />
        )}
        <div style={{ flex: 1, overflow: 'auto', background: C.pageBg, display: 'flex', flexDirection: 'column' }}>
          {renderPage()}
        </div>
      </div>
    </div>
  );
}
