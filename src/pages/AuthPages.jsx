import React from "react";
import { Link, Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { accountText } from "../account-copy.js";
import { resetTokenFromHash, safeNextPath } from "../account-utils.js";
import { useAuth } from "../auth.jsx";
import { AccountLoading, ApiErrorNotice, FormField, SuccessNotice } from "../components/AccountUi.jsx";
import { TURNSTILE_CONFIG, TurnstileWidget } from "../components/TurnstileWidget.jsx";
import { useShop } from "../shop.jsx";

const emailValid = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim());

function AuthShell({ title, lead, children, aside }) {
  const { lang } = useShop();
  return (
    <div className="wrap page auth-page">
      <div className="auth-shell">
        <div className="auth-heading">
          <Link to="/" className="auth-back">← {accountText(lang, "back")}</Link>
          <h1>{title}</h1>
          <p>{lead}</p>
        </div>
        {children}
        {aside && <div className="auth-aside">{aside}</div>}
      </div>
    </div>
  );
}

function SubmitButton({ busy, children, language }) {
  return (
    <button className="account-primary" type="submit" disabled={busy || !TURNSTILE_CONFIG.configured}>
      {busy ? accountText(language, "saving") : children}
    </button>
  );
}

function LoginPage() {
  const { lang } = useShop();
  const auth = useAuth();
  const [params] = useSearchParams();
  const next = safeNextPath(params.get("next"));
  const [form, setForm] = React.useState({ email: "", password: "" });
  const [token, setToken] = React.useState("");
  const [errors, setErrors] = React.useState({});
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [resetKey, setResetKey] = React.useState(0);

  if (auth.status === "loading") return <AuthShell title={accountText(lang, "signInTitle")} lead={accountText(lang, "signInLead")}><AccountLoading language={lang} /></AuthShell>;
  if (auth.user) return <Navigate replace to={next} />;
  const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const submit = async (event) => {
    event.preventDefault();
    const nextErrors = {};
    if (!emailValid(form.email)) nextErrors.email = accountText(lang, "invalidEmail");
    if (!form.password) nextErrors.password = accountText(lang, "required");
    if (!token) nextErrors.turnstile = accountText(lang, "verifyHuman");
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    setBusy(true);
    setError(null);
    try {
      await auth.login({ email: form.email, password: form.password, turnstileToken: token });
    } catch (caught) {
      setError(caught);
      setResetKey((value) => value + 1);
    } finally { setBusy(false); }
  };
  return (
    <AuthShell
      title={accountText(lang, "signInTitle")}
      lead={accountText(lang, "signInLead")}
      aside={<>{accountText(lang, "noAccount")} <Link to={`/register?next=${encodeURIComponent(next)}`}>{accountText(lang, "register")}</Link></>}
    >
      {params.get("expired") === "1" && <div className="auth-alert info" role="status">{accountText(lang, "sessionExpired")}</div>}
      <ApiErrorNotice error={error || auth.sessionError} language={lang} />
      <form className="auth-form" onSubmit={submit} noValidate>
        <FormField label={accountText(lang, "email")} error={errors.email}>
          <input type="email" value={form.email} onChange={update("email")} autoComplete="email" required />
        </FormField>
        <FormField label={accountText(lang, "password")} error={errors.password}>
          <input type="password" value={form.password} onChange={update("password")} autoComplete="current-password" required />
        </FormField>
        <div className="auth-inline-link"><Link to="/forgot-password">{accountText(lang, "forgotPassword")}</Link></div>
        <TurnstileWidget action="login" language={lang} onToken={setToken} resetKey={resetKey} />
        {errors.turnstile && <p className="field-error" role="alert">{errors.turnstile}</p>}
        <SubmitButton busy={busy} language={lang}>{accountText(lang, "signIn")}</SubmitButton>
      </form>
    </AuthShell>
  );
}

function RegisterPage() {
  const { lang } = useShop();
  const auth = useAuth();
  const [params] = useSearchParams();
  const next = safeNextPath(params.get("next"));
  const [form, setForm] = React.useState({ name: "", phone: "", email: "", password: "", confirm: "" });
  const [token, setToken] = React.useState("");
  const [errors, setErrors] = React.useState({});
  const [error, setError] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [resetKey, setResetKey] = React.useState(0);
  if (auth.status === "loading") return <AuthShell title={accountText(lang, "registerTitle")} lead={accountText(lang, "registerLead")}><AccountLoading language={lang} /></AuthShell>;
  if (auth.user) return <Navigate replace to={next} />;
  const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const submit = async (event) => {
    event.preventDefault();
    const nextErrors = {};
    if (form.name.trim().length < 2) nextErrors.name = accountText(lang, "required");
    if (!emailValid(form.email)) nextErrors.email = accountText(lang, "invalidEmail");
    if (form.password.length < 10) nextErrors.password = accountText(lang, "passwordLength");
    if (form.password !== form.confirm) nextErrors.confirm = accountText(lang, "passwordsMismatch");
    if (!token) nextErrors.turnstile = accountText(lang, "verifyHuman");
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    setBusy(true);
    setError(null);
    try {
      await auth.register({
        name: form.name,
        phone: form.phone,
        email: form.email,
        password: form.password,
        turnstileToken: token,
      });
    } catch (caught) {
      setError(caught);
      setResetKey((value) => value + 1);
    } finally { setBusy(false); }
  };
  return (
    <AuthShell
      title={accountText(lang, "registerTitle")}
      lead={accountText(lang, "registerLead")}
      aside={<>{accountText(lang, "haveAccount")} <Link to={`/login?next=${encodeURIComponent(next)}`}>{accountText(lang, "signIn")}</Link></>}
    >
      <ApiErrorNotice error={error} language={lang} />
      <form className="auth-form" onSubmit={submit} noValidate>
        <FormField label={accountText(lang, "fullName")} error={errors.name}>
          <input value={form.name} onChange={update("name")} autoComplete="name" required />
        </FormField>
        <FormField label={accountText(lang, "phone")}>
          <input type="tel" value={form.phone} onChange={update("phone")} autoComplete="tel" />
        </FormField>
        <FormField label={accountText(lang, "email")} error={errors.email}>
          <input type="email" value={form.email} onChange={update("email")} autoComplete="email" required />
        </FormField>
        <FormField label={accountText(lang, "password")} error={errors.password}>
          <input type="password" value={form.password} onChange={update("password")} autoComplete="new-password" required />
        </FormField>
        <FormField label={accountText(lang, "confirmPassword")} error={errors.confirm}>
          <input type="password" value={form.confirm} onChange={update("confirm")} autoComplete="new-password" required />
        </FormField>
        <TurnstileWidget action="register" language={lang} onToken={setToken} resetKey={resetKey} />
        {errors.turnstile && <p className="field-error" role="alert">{errors.turnstile}</p>}
        <SubmitButton busy={busy} language={lang}>{accountText(lang, "register")}</SubmitButton>
      </form>
    </AuthShell>
  );
}

function ForgotPasswordPage() {
  const { lang } = useShop();
  const auth = useAuth();
  const [email, setEmail] = React.useState("");
  const [token, setToken] = React.useState("");
  const [error, setError] = React.useState(null);
  const [fieldError, setFieldError] = React.useState("");
  const [done, setDone] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [resetKey, setResetKey] = React.useState(0);
  const submit = async (event) => {
    event.preventDefault();
    if (!emailValid(email)) { setFieldError(accountText(lang, "invalidEmail")); return; }
    if (!token) { setFieldError(accountText(lang, "verifyHuman")); return; }
    setBusy(true);
    setError(null);
    setFieldError("");
    try {
      await auth.forgotPassword({ email, locale: lang, turnstileToken: token });
      setDone(true);
    } catch (caught) {
      setError(caught);
      setResetKey((value) => value + 1);
    } finally { setBusy(false); }
  };
  return (
    <AuthShell title={accountText(lang, "forgotTitle")} lead={accountText(lang, "forgotLead")} aside={<Link to="/login">{accountText(lang, "back")}</Link>}>
      <ApiErrorNotice error={error} language={lang} />
      <SuccessNotice>{done ? accountText(lang, "forgotSent") : ""}</SuccessNotice>
      {!done && <form className="auth-form" onSubmit={submit} noValidate>
        <FormField label={accountText(lang, "email")} error={fieldError}>
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
        </FormField>
        <TurnstileWidget action="forgot_password" language={lang} onToken={setToken} resetKey={resetKey} />
        <SubmitButton busy={busy} language={lang}>{accountText(lang, "sendReset")}</SubmitButton>
      </form>}
    </AuthShell>
  );
}

function ResetPasswordPage() {
  const { lang } = useShop();
  const auth = useAuth();
  const [token] = React.useState(() => resetTokenFromHash(window.location.hash));
  const [form, setForm] = React.useState({ password: "", confirm: "" });
  const [turnstileToken, setTurnstileToken] = React.useState("");
  const [errors, setErrors] = React.useState({});
  const [error, setError] = React.useState(null);
  const [done, setDone] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [resetKey, setResetKey] = React.useState(0);
  React.useEffect(() => {
    if (window.location.hash) window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
  }, []);
  const update = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const submit = async (event) => {
    event.preventDefault();
    const nextErrors = {};
    if (form.password.length < 10) nextErrors.password = accountText(lang, "passwordLength");
    if (form.password !== form.confirm) nextErrors.confirm = accountText(lang, "passwordsMismatch");
    if (!turnstileToken) nextErrors.turnstile = accountText(lang, "verifyHuman");
    setErrors(nextErrors);
    if (!token || Object.keys(nextErrors).length) return;
    setBusy(true);
    setError(null);
    try {
      await auth.resetPassword({ token, password: form.password, turnstileToken });
      setDone(true);
    } catch (caught) {
      setError(caught);
      setResetKey((value) => value + 1);
    } finally { setBusy(false); }
  };
  return (
    <AuthShell title={accountText(lang, "resetTitle")} lead={accountText(lang, "resetLead")} aside={<Link to="/login">{accountText(lang, "signIn")}</Link>}>
      {!token && <div className="auth-alert error" role="alert">{accountText(lang, "invalidResetLink")}</div>}
      <ApiErrorNotice error={error} language={lang} />
      <SuccessNotice>{done ? accountText(lang, "resetDone") : ""}</SuccessNotice>
      {token && !done && <form className="auth-form" onSubmit={submit} noValidate>
        <FormField label={accountText(lang, "newPassword")} error={errors.password}>
          <input type="password" value={form.password} onChange={update("password")} autoComplete="new-password" required />
        </FormField>
        <FormField label={accountText(lang, "confirmPassword")} error={errors.confirm}>
          <input type="password" value={form.confirm} onChange={update("confirm")} autoComplete="new-password" required />
        </FormField>
        <TurnstileWidget action="reset_password" language={lang} onToken={setTurnstileToken} resetKey={resetKey} />
        {errors.turnstile && <p className="field-error" role="alert">{errors.turnstile}</p>}
        <SubmitButton busy={busy} language={lang}>{accountText(lang, "resetPassword")}</SubmitButton>
      </form>}
    </AuthShell>
  );
}

function LogoutPage() {
  const { lang } = useShop();
  const auth = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = React.useState(null);
  React.useEffect(() => {
    if (auth.status === "loading") return undefined;
    if (!auth.user) { navigate("/", { replace: true }); return undefined; }
    let active = true;
    auth.logout().then(() => {
      if (active) navigate("/", { replace: true });
    }).catch((caught) => { if (active) setError(caught); });
    return () => { active = false; };
  }, [auth.status, auth.user, location.key]);
  return (
    <AuthShell title={accountText(lang, "logout")} lead={accountText(lang, "loggingOut")}>
      <ApiErrorNotice error={error} language={lang} />
      {error && <button className="account-primary" type="button" onClick={() => window.location.reload()}>{accountText(lang, "retry")}</button>}
    </AuthShell>
  );
}

export default function AuthPages({ mode }) {
  if (mode === "register") return <RegisterPage />;
  if (mode === "forgot") return <ForgotPasswordPage />;
  if (mode === "reset") return <ResetPasswordPage />;
  if (mode === "logout") return <LogoutPage />;
  return <LoginPage />;
}
