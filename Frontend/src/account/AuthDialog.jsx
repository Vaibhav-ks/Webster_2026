// Sign in / create account / link Google. Rendered as an overlay above the editor:
// nothing navigates or reloads, so an open editing session is untouched throughout.

import { useEffect, useRef, useState } from 'react';
import { useAuthStore } from './useAuthStore.js';
import { useProjectStore } from './useProjectStore.js';
import { googleEnabled, renderGoogleButton } from './googleIdentity.js';
import { useTheme } from '../store/useTheme.js';
import { Modal, ErrorNote, Note, btn, primary, ghost, input } from './ui.jsx';

export default function AuthDialog() {
  const dialog = useAuthStore((s) => s.dialog);
  const status = useAuthStore((s) => s.status);
  const closeAuth = useAuthStore((s) => s.closeAuth);
  if (!dialog) return null;
  if (dialog.mode === 'link' || dialog.mode === 'link-signed-in') return <LinkGoogle dialog={dialog} onClose={closeAuth} />;
  if (status === 'authenticated') return null;
  return <SignIn dialog={dialog} onClose={closeAuth} />;
}

/** After signing in from the Save button, continue straight to the save dialog. */
function afterSignIn(dialog) {
  useAuthStore.getState().closeAuth();
  if (dialog.reason === 'save') useProjectStore.getState().openDialog('save');
}

function SignIn({ dialog, onClose }) {
  const register = dialog.mode === 'register';
  const [form, setForm] = useState({ email: '', password: '', displayName: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const auth = useAuthStore.getState();

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (register) await auth.register({ ...form, displayName: form.displayName.trim() || undefined });
      else await auth.login(form);
      afterSignIn(dialog);
    } catch (err) {
      setError(fieldMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const onGoogle = async (credential) => {
    setBusy(true);
    setError(null);
    try {
      await auth.loginWithGoogle(credential);
      afterSignIn(dialog);
    } catch (err) {
      if (err.code === 'LINK_REQUIRED' && err.details?.hasPassword) {
        useAuthStore.setState({ dialog: { ...dialog, mode: 'link', link: { credential, email: err.details.email } } });
      } else setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={register ? 'Create your account' : 'Sign in'} onClose={busy ? undefined : onClose}>
      {dialog.reason === 'save' && (
        <Note>Sign in to save this project to your account. Your current video and edits stay right here.</Note>
      )}
      <form className="mt-4 space-y-3" onSubmit={submit}>
        {register && (
          <label className="block text-sm">
            <span className="mb-1 block text-muted">Name</span>
            <input className={input} value={form.displayName} onChange={set('displayName')} autoComplete="name" maxLength={100} />
          </label>
        )}
        <label className="block text-sm">
          <span className="mb-1 block text-muted">Email</span>
          <input className={input} type="email" required value={form.email} onChange={set('email')} autoComplete="email" />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-muted">Password</span>
          <input
            className={input}
            type="password"
            required
            minLength={register ? 8 : 1}
            maxLength={128}
            value={form.password}
            onChange={set('password')}
            autoComplete={register ? 'new-password' : 'current-password'}
          />
          {register && <span className="mt-1 block text-xs text-subtle">At least 8 characters.</span>}
        </label>
        <ErrorNote>{error}</ErrorNote>
        <button type="submit" className={`${btn} ${primary} w-full`} disabled={busy}>
          {busy ? 'Please wait…' : register ? 'Create account' : 'Sign in'}
        </button>
      </form>

      {googleEnabled && (
        <>
          <div className="my-4 flex items-center gap-3 text-xs text-subtle">
            <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
          </div>
          <GoogleButton onCredential={onGoogle} onError={setError} />
        </>
      )}

      <p className="mt-5 text-center text-sm text-muted">
        {register ? 'Already have an account?' : 'New here?'}{' '}
        <button
          type="button"
          className="font-semibold text-accent hover:underline"
          onClick={() => {
            setError(null);
            useAuthStore.getState().setDialogMode(register ? 'signin' : 'register');
          }}
        >
          {register ? 'Sign in' : 'Create an account'}
        </button>
      </p>
      <p className="mt-2 text-center text-xs text-subtle">You can keep editing without an account.</p>
    </Modal>
  );
}

/**
 * Link a Google account to an existing account. Two entry points:
 *  - mode 'link': Google sign-in found an existing email/password account. The user
 *    proves they own it (password) -> sign in -> link, all in one step.
 *  - mode 'link-signed-in': from the account menu; re-enter password, then pick Google.
 */
function LinkGoogle({ dialog, onClose }) {
  const auth = useAuthStore.getState();
  const user = useAuthStore((s) => s.user);
  const [password, setPassword] = useState('');
  const [credential, setCredential] = useState(dialog.link?.credential ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const fromSignIn = dialog.mode === 'link';
  const needsPassword = fromSignIn || user?.hasPassword;

  const submit = async (e) => {
    e?.preventDefault();
    if (!credential) return setError('Choose your Google account first.');
    setBusy(true);
    setError(null);
    try {
      if (fromSignIn) await auth.login({ email: dialog.link.email, password });
      await auth.linkGoogle({ credential, password: needsPassword ? password : undefined });
      useProjectStore.getState().showToast('Google sign-in is now linked to your account.', 'success');
      afterSignIn(dialog);
    } catch (err) {
      setError(err.code === 'INVALID_CREDENTIALS' ? 'That password is incorrect.' : err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Link Google sign-in" onClose={busy ? undefined : onClose}>
      {fromSignIn ? (
        <Note>
          An account for <strong className="text-fg">{dialog.link.email}</strong> already exists. Enter its password to link
          Google, so you can use either one to sign in to the same account.
        </Note>
      ) : (
        <Note>Link a Google account so you can sign in with either your password or Google.</Note>
      )}
      <form className="mt-4 space-y-3" onSubmit={submit}>
        {needsPassword && (
          <label className="block text-sm">
            <span className="mb-1 block text-muted">Password for {fromSignIn ? dialog.link.email : user?.email}</span>
            <input
              className={input}
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
            />
          </label>
        )}
        {!fromSignIn &&
          (credential ? (
            <p className="text-sm text-muted">Google account selected.</p>
          ) : (
            <GoogleButton onCredential={setCredential} onError={setError} />
          ))}
        <ErrorNote>{error}</ErrorNote>
        <div className="flex gap-2 pt-1">
          <button type="submit" className={`${btn} ${primary} flex-1`} disabled={busy || !credential}>
            {busy ? 'Linking…' : 'Link Google'}
          </button>
          <button type="button" className={`${btn} ${ghost}`} onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

function GoogleButton({ onCredential, onError }) {
  const ref = useRef(null);
  const dark = useTheme((s) => s.theme) === 'dark';
  const cb = useRef(onCredential);
  cb.current = onCredential;
  useEffect(() => {
    let cleanup = () => {};
    let alive = true;
    renderGoogleButton(ref.current, (c) => cb.current(c), { dark })
      .then((fn) => (alive ? (cleanup = fn) : fn()))
      .catch((err) => onError?.(err.message));
    return () => {
      alive = false;
      cleanup();
    };
  }, [dark, onError]);
  return <div ref={ref} className="flex min-h-[44px] justify-center" />;
}

function fieldMessage(err) {
  if (err.code === 'VALIDATION' && err.details?.length) return err.details[0].message;
  return err.message;
}
