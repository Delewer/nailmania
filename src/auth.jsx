import React from "react";
import {
  accountApiRequest,
  accountEndpoints,
  addressEndpoint,
  orderEndpoint,
} from "./account-api.js";

const AuthContext = React.createContext(null);

export function AuthProvider({ children }) {
  const [status, setStatus] = React.useState("loading");
  const [user, setUser] = React.useState(null);
  const [sessionError, setSessionError] = React.useState(null);
  const [sessionExpired, setSessionExpired] = React.useState(false);
  const [addresses, setAddresses] = React.useState([]);
  const [addressesLoading, setAddressesLoading] = React.useState(false);
  const [addressesError, setAddressesError] = React.useState(null);

  const expireSession = React.useCallback((error) => {
    setUser((current) => {
      if (current) setSessionExpired(true);
      return null;
    });
    setAddresses([]);
    setStatus("guest");
    setSessionError(error);
  }, []);

  const privateRequest = React.useCallback((path, options = {}) => accountApiRequest(path, {
    ...options,
    onUnauthorized: expireSession,
  }), [expireSession]);

  const refreshAddresses = React.useCallback(async ({ signal } = {}) => {
    setAddressesLoading(true);
    setAddressesError(null);
    try {
      const payload = await privateRequest(accountEndpoints.addresses, { signal });
      setAddresses(Array.isArray(payload.items) ? payload.items : []);
      return payload.items || [];
    } catch (error) {
      if (error?.name !== "AbortError") setAddressesError(error);
      throw error;
    } finally {
      setAddressesLoading(false);
    }
  }, [privateRequest]);

  const refreshSession = React.useCallback(async ({ signal } = {}) => {
    setSessionError(null);
    try {
      const payload = await accountApiRequest(accountEndpoints.session, { signal });
      if (payload.authenticated && payload.user) {
        setUser(payload.user);
        setStatus("authenticated");
        return payload.user;
      }
      setUser(null);
      setAddresses([]);
      setStatus("guest");
      return null;
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      setSessionError(error);
      setUser(null);
      setAddresses([]);
      setStatus("guest");
      return null;
    }
  }, []);

  React.useEffect(() => {
    const controller = new AbortController();
    refreshSession({ signal: controller.signal }).then((activeUser) => {
      if (!activeUser || controller.signal.aborted) return;
      refreshAddresses({ signal: controller.signal }).catch(() => {});
    }).catch(() => {});
    return () => controller.abort();
  }, [refreshAddresses, refreshSession]);

  const acceptUser = React.useCallback((nextUser) => {
    setUser(nextUser);
    setStatus("authenticated");
    setSessionExpired(false);
    setSessionError(null);
    refreshAddresses().catch(() => {});
    return nextUser;
  }, [refreshAddresses]);

  const login = React.useCallback(async (input) => {
    const payload = await accountApiRequest(accountEndpoints.login, { method: "POST", body: input });
    return acceptUser(payload.user);
  }, [acceptUser]);

  const register = React.useCallback(async (input) => {
    const payload = await accountApiRequest(accountEndpoints.register, { method: "POST", body: input });
    return acceptUser(payload.user);
  }, [acceptUser]);

  const logout = React.useCallback(async () => {
    await privateRequest(accountEndpoints.logout, { method: "POST", body: {} });
    setUser(null);
    setAddresses([]);
    setStatus("guest");
    setSessionExpired(false);
    setSessionError(null);
  }, [privateRequest]);

  const forgotPassword = React.useCallback((input) => accountApiRequest(accountEndpoints.forgotPassword, {
    method: "POST",
    body: input,
  }), []);

  const resetPassword = React.useCallback(async (input) => {
    const payload = await accountApiRequest(accountEndpoints.resetPassword, { method: "POST", body: input });
    setUser(null);
    setAddresses([]);
    setStatus("guest");
    setSessionExpired(false);
    setSessionError(null);
    return payload;
  }, []);

  const updateProfile = React.useCallback(async (input) => {
    const payload = await privateRequest(accountEndpoints.profile, { method: "PATCH", body: input });
    setUser(payload.user);
    return payload.user;
  }, [privateRequest]);

  const createAddress = React.useCallback(async (input) => {
    const payload = await privateRequest(accountEndpoints.addresses, { method: "POST", body: input });
    setAddresses((current) => [
      payload.address,
      ...current.map((address) => payload.address.isDefault ? { ...address, isDefault: false } : address),
    ].sort((left, right) => Number(right.isDefault) - Number(left.isDefault)));
    return payload.address;
  }, [privateRequest]);

  const updateAddress = React.useCallback(async (id, input) => {
    const payload = await privateRequest(addressEndpoint(id), { method: "PATCH", body: input });
    setAddresses((current) => current
      .map((address) => address.id === id
        ? payload.address
        : payload.address.isDefault ? { ...address, isDefault: false } : address)
      .sort((left, right) => Number(right.isDefault) - Number(left.isDefault)));
    return payload.address;
  }, [privateRequest]);

  const deleteAddress = React.useCallback(async (id) => {
    await privateRequest(addressEndpoint(id), { method: "DELETE" });
    setAddresses((current) => {
      const remaining = current.filter((address) => address.id !== id);
      if (remaining.length && !remaining.some((address) => address.isDefault)) remaining[0] = { ...remaining[0], isDefault: true };
      return remaining;
    });
    refreshAddresses().catch(() => {});
  }, [privateRequest, refreshAddresses]);

  const loadOrders = React.useCallback(({ limit = 10, offset = 0, status: orderStatus = "", signal } = {}) => {
    const search = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (orderStatus) search.set("status", orderStatus);
    return privateRequest(`${accountEndpoints.orders}?${search}`, { signal });
  }, [privateRequest]);
  const loadOrder = React.useCallback((id, options = {}) => privateRequest(orderEndpoint(id), options), [privateRequest]);
  const defaultAddress = addresses.find((address) => address.isDefault) || null;

  const value = React.useMemo(() => ({
    status,
    user,
    sessionError,
    sessionExpired,
    addresses,
    defaultAddress,
    addressesLoading,
    addressesError,
    login,
    register,
    logout,
    forgotPassword,
    resetPassword,
    updateProfile,
    refreshSession,
    refreshAddresses,
    createAddress,
    updateAddress,
    deleteAddress,
    loadOrders,
    loadOrder,
    privateRequest,
  }), [
    addresses, addressesError, addressesLoading, createAddress, defaultAddress,
    deleteAddress, forgotPassword, loadOrder, loadOrders, login, logout,
    privateRequest, refreshAddresses, refreshSession, register, resetPassword,
    sessionError, sessionExpired, status, updateAddress, updateProfile, user,
  ]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = React.useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside AuthProvider");
  return value;
}
