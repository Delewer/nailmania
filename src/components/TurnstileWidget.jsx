import React from "react";
import { accountText } from "../account-copy.js";
import { resolveTurnstileSiteKey } from "../account-utils.js";

const SCRIPT_ID = "nm-turnstile-script";
const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let scriptPromise = null;

function loadTurnstile() {
  if (globalThis.window?.turnstile) return Promise.resolve(globalThis.window.turnstile);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID);
    const script = existing || document.createElement("script");
    const onLoad = () => window.turnstile ? resolve(window.turnstile) : reject(new Error("Turnstile API missing"));
    const onError = () => reject(new Error("Turnstile script failed to load"));
    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", onError, { once: true });
    if (!existing) {
      script.id = SCRIPT_ID;
      script.src = SCRIPT_URL;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  }).catch((error) => {
    scriptPromise = null;
    throw error;
  });
  return scriptPromise;
}

export const TURNSTILE_CONFIG = resolveTurnstileSiteKey({
  configuredKey: import.meta.env.VITE_TURNSTILE_SITE_KEY,
  isDevelopment: Boolean(import.meta.env.DEV),
  isTest: import.meta.env.MODE === "test",
});

export function TurnstileWidget({ action, language = "ro", onToken, resetKey = 0 }) {
  const containerRef = React.useRef(null);
  const widgetRef = React.useRef(null);
  const onTokenRef = React.useRef(onToken);
  const [failed, setFailed] = React.useState(false);
  onTokenRef.current = onToken;

  React.useEffect(() => {
    if (!TURNSTILE_CONFIG.configured) {
      onTokenRef.current?.("");
      return undefined;
    }
    let cancelled = false;
    setFailed(false);
    onTokenRef.current?.("");
    loadTurnstile().then((turnstile) => {
      if (cancelled || !containerRef.current) return;
      widgetRef.current = turnstile.render(containerRef.current, {
        sitekey: TURNSTILE_CONFIG.key,
        action,
        language,
        theme: "light",
        size: "flexible",
        callback: (token) => onTokenRef.current?.(String(token || "")),
        "expired-callback": () => onTokenRef.current?.(""),
        "timeout-callback": () => onTokenRef.current?.(""),
        "error-callback": () => {
          setFailed(true);
          onTokenRef.current?.("");
          return true;
        },
      });
    }).catch(() => {
      if (!cancelled) {
        setFailed(true);
        onTokenRef.current?.("");
      }
    });
    return () => {
      cancelled = true;
      if (widgetRef.current != null && window.turnstile) {
        try { window.turnstile.remove(widgetRef.current); } catch { /* already removed */ }
      }
      widgetRef.current = null;
    };
  }, [action, language]);

  React.useEffect(() => {
    if (widgetRef.current != null && window.turnstile) {
      try { window.turnstile.reset(widgetRef.current); } catch { /* widget is being replaced */ }
      onTokenRef.current?.("");
    }
  }, [resetKey]);

  if (!TURNSTILE_CONFIG.configured) {
    return <p className="auth-alert error" role="alert">{accountText(language, "turnstileMissing")}</p>;
  }
  return (
    <div className="turnstile-wrap">
      <div ref={containerRef} className="turnstile-slot" aria-label={accountText(language, "verifyHuman")} />
      {failed && <p className="auth-alert error" role="alert">{accountText(language, "turnstileError")}</p>}
    </div>
  );
}
