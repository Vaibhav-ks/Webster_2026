// Who is signed in, and the sign-in dialog. Completely separate from the editor
// store: signing in, out or failing to never touches the editing session.

import { create } from 'zustand';
import { api, refreshSession, setAccessToken, setSessionListener } from './api.js';

export const useAuthStore = create((set, get) => ({
  status: 'unknown', // unknown | guest | authenticated
  user: null,
  // null | { mode: 'signin' | 'register' | 'link', reason?: 'save', link?: { credential, email } }
  dialog: null,

  async bootstrap() {
    // A sleeping API host can take a while to answer; don't hold the UI hostage. Show
    // guest mode after a few seconds and upgrade when the session check returns.
    const slow = setTimeout(() => get().status === 'unknown' && set({ status: 'guest' }), 8000);
    try {
      const user = await refreshSession();
      if (user) set({ status: 'authenticated', user });
      else if (get().status !== 'authenticated') set({ status: 'guest', user: null });
    } catch {
      if (get().status !== 'authenticated') set({ status: 'guest', user: null }); // backend unreachable: guest mode works
    } finally {
      clearTimeout(slow);
    }
  },

  openAuth(opts = {}) {
    set({ dialog: { mode: 'signin', ...opts } });
  },
  closeAuth() {
    set({ dialog: null });
  },
  setDialogMode(mode) {
    const d = get().dialog;
    if (d) set({ dialog: { ...d, mode } });
  },

  _signedIn(data) {
    setAccessToken(data.accessToken);
    set({ status: 'authenticated', user: data.user });
    return data.user;
  },

  async register({ email, password, displayName }) {
    const data = await api('/auth/register', { method: 'POST', auth: false, body: { email, password, displayName } });
    return get()._signedIn(data);
  },

  async login({ email, password }) {
    const data = await api('/auth/login', { method: 'POST', auth: false, body: { email, password } });
    return get()._signedIn(data);
  },

  /** Throws ApiError LINK_REQUIRED when the email belongs to an existing account. */
  async loginWithGoogle(credential) {
    const data = await api('/auth/google', { method: 'POST', auth: false, body: { credential } });
    return get()._signedIn(data);
  },

  async linkGoogle({ credential, password }) {
    const data = await api('/auth/google/link', { method: 'POST', body: { credential, password } });
    set({ user: data.user });
    return data.user;
  },

  async logout() {
    try {
      await api('/auth/logout', { method: 'POST', auth: false, csrf: true });
    } catch {
      // Even if the server can't be reached, forget the session locally.
    }
    setAccessToken(null);
    set({ status: 'guest', user: null, dialog: null });
  },
}));

setSessionListener((user) => {
  useAuthStore.setState(user ? { status: 'authenticated', user } : { status: 'guest', user: null });
});
