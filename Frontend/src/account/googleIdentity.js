// Google Identity Services "Sign in with Google" button, popup mode only, so the
// page (and the editing session in it) is never reloaded or redirected. The ID token
// it returns is only a claim: the backend verifies it before trusting anything.

const CLIENT_ID = import.meta.env?.VITE_GOOGLE_CLIENT_ID || '';
export const googleEnabled = Boolean(CLIENT_ID);

let loading = null;
let initialized = false;
let handler = null;

function loadScript() {
  loading ??= new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      loading = null;
      reject(new Error('Google sign-in could not be loaded. Check your connection or use email instead.'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/**
 * Render the Google button into `el`; `onCredential(idToken)` runs after the user picks
 * an account. Returns a cleanup function.
 */
export async function renderGoogleButton(el, onCredential, { dark = true } = {}) {
  if (!googleEnabled) return () => {};
  await loadScript();
  const gid = window.google.accounts.id;
  if (!initialized) {
    gid.initialize({
      client_id: CLIENT_ID,
      callback: (response) => handler?.(response.credential),
      ux_mode: 'popup',
      auto_select: false,
      cancel_on_tap_outside: true,
    });
    initialized = true;
  }
  handler = onCredential;
  el.replaceChildren();
  gid.renderButton(el, {
    type: 'standard',
    theme: dark ? 'filled_black' : 'outline',
    size: 'large',
    text: 'continue_with',
    shape: 'pill',
    width: Math.max(200, Math.min(el.clientWidth || 320, 400)),
  });
  return () => {
    if (handler === onCredential) handler = null;
  };
}
