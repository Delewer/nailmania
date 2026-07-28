import React from "react";
import { Navigate, useLocation } from "react-router-dom";
import { accountErrorText, accountText } from "../account-copy.js";
import { useAuth } from "../auth.jsx";

export function ApiErrorNotice({ error, language = "ro" }) {
  if (!error) return null;
  return (
    <div className="auth-alert error" role="alert">
      <span>{accountErrorText(language, error)}</span>
      {error.requestId && <small>{accountText(language, "requestReference", { id: error.requestId })}</small>}
    </div>
  );
}

export function SuccessNotice({ children }) {
  if (!children) return null;
  return <div className="auth-alert success" role="status">{children}</div>;
}

export function AccountLoading({ language = "ro" }) {
  return <div className="account-loading" role="status"><span className="account-spinner" />{accountText(language, "loading")}</div>;
}

export function ProtectedAccount({ language = "ro", children }) {
  const auth = useAuth();
  const location = useLocation();
  if (auth.status === "loading") {
    return <div className="wrap page"><AccountLoading language={language} /></div>;
  }
  if (!auth.user) {
    const next = `${location.pathname}${location.search}`;
    return <Navigate replace to={`/login?next=${encodeURIComponent(next)}${auth.sessionExpired ? "&expired=1" : ""}`} />;
  }
  return children;
}

export function FormField({ label, error, className = "", children }) {
  const generatedId = React.useId();
  const fieldId = children?.props?.id || `account-field-${generatedId.replaceAll(":", "")}`;
  const errorId = `${fieldId}-error`;
  return (
    <div className={`account-field${error ? " error" : ""}${className ? ` ${className}` : ""}`}>
      <label htmlFor={fieldId}>{label}</label>
      {React.isValidElement(children) ? React.cloneElement(children, {
        id: fieldId,
        "aria-invalid": error ? "true" : undefined,
        "aria-describedby": error ? errorId : children.props["aria-describedby"],
      }) : children}
      {error && <small id={errorId} role="alert">{error}</small>}
    </div>
  );
}
