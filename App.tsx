import React from 'react';
import { Routes, Route } from 'react-router-dom';
import LobbyPage from './pages/LobbyPage';
import RoomPage from './pages/RoomPage';
import TrackerPage from './pages/TrackerPage';
import ReviewSetupRedirect from './pages/ReviewSetupRedirect';
import LaunchPage from './pages/LaunchPage';
import AccessGatePage from './pages/AccessGatePage';
import AdminPage from './pages/AdminPage';
import { ConfigProvider } from './lib/config/ConfigContext';
import { AccessGate } from './lib/access/AccessGate';
import { IdentityGate } from './components/auth/IdentityGate';

// ConfigProvider wraps every route so any component can ask which connector is
// active. It never blocks rendering: children mount immediately and read the
// pre-config fallbacks until /api/public-config settles (or fails).
//
// The two gates are ordered: AccessGate is the deployment's shared password
// (meaningful when identity is 'none'), IdentityGate is the per-person door
// that the identity block configures. IdentityGate renders its children
// untouched — and never calls Supabase — when identity.mode is 'none', which is
// the default, so a plain install is exactly what it was before identity.
const App: React.FC = () => {
  return (
    <ConfigProvider>
      <AccessGate fallback={<AccessGatePage />}>
        <IdentityGate>
          <Routes>
            <Route path="/" element={<LobbyPage />} />
            <Route path="/room/:roomId" element={<RoomPage />} />
            {/* The curate page's address, kept because it is still out there —
                bookmarks, tracker and PLM links, messages sent last week. Batch BH
                moved the curation into the room, so this redirects rather than
                rendering. See pages/ReviewSetupRedirect.tsx. */}
            <Route path="/review/:reviewId/setup" element={<ReviewSetupRedirect />} />
            <Route path="/tracker" element={<TrackerPage />} />
            {/* Admin screen — behind its own passphrase gate (useAdminGate),
                but also inside the front-door AccessGate so the deployment
                password protects it too. */}
            <Route path="/admin" element={<AdminPage />} />
            {/* Deep link a PLM system opens directly (T5.3). Both vercel.json and
                deploy/nginx/app.conf already fall back to index.html for unknown
                non-/api paths, so this needs no server-side route. */}
            <Route path="/launch" element={<LaunchPage />} />
          </Routes>
        </IdentityGate>
      </AccessGate>
    </ConfigProvider>
  );
};

export default App;