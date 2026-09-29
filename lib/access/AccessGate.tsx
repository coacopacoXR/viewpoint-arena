// AccessGate — renders children when the deployment is unlocked (or when no
// password is configured), and the fallback gate screen when it is not.
//
// While loading, renders nothing (the app shell is blank for a frame). When
// the endpoint is unreachable the hook resolves to { required: false } so the
// gate never blocks on a missing server — same fail-open as the config context.

import React from 'react';
import { useAccessGate } from './useAccessGate.ts';

interface AccessGateProps {
  children: React.ReactNode;
  fallback: React.ReactNode;
}

export const AccessGate: React.FC<AccessGateProps> = ({ children, fallback }) => {
  const { required, unlocked, loading } = useAccessGate();

  if (loading) return null;
  if (required && !unlocked) return <>{fallback}</>;
  return <>{children}</>;
};
