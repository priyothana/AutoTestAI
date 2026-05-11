"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Logo from "@/components/shared/Logo";

const API = process.env.NEXT_PUBLIC_API_URL;

// ── Modal shows only the password-reset step (no email step) ─────────────────
type ModalStep = "closed" | "sending" | "reset";

export default function LoginPage() {
  const router = useRouter();

  // ── Login state ──────────────────────────────────────────────────────────
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState("");
  const [loading, setLoading]       = useState(false);

  // ── Forgot-password state ────────────────────────────────────────────────
  const [modalStep, setModalStep]   = useState<ModalStep>("closed");
  const [fpError, setFpError]       = useState("");        // error shown in modal header
  const [resetToken, setResetToken] = useState("");
  const [resetNewPw, setResetNewPw] = useState("");
  const [resetConfirmPw, setResetConfirmPw] = useState("");
  const [resetError, setResetError]         = useState("");
  const [resetSubmitting, setResetSubmitting] = useState(false);
  const [resetSuccess, setResetSuccess]       = useState(false);
  // The identifier (username or email) auto-filled from the login field
  const [fpIdentifier, setFpIdentifier] = useState("");

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError("");
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/v1/users/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const contentType = res.headers.get("content-type");
      if (!res.ok) {
        if (contentType?.includes("application/json")) {
          const data = await res.json();
          let msg = "Login failed";
          if (typeof data.detail === "string") msg = data.detail;
          else if (Array.isArray(data.detail)) msg = data.detail.map((e: any) => e.msg).join(", ");
          else if (data.message) msg = data.message;
          throw new Error(msg);
        } else {
          throw new Error(`Server error ${res.status}. Check backend logs.`);
        }
      }
      if (!contentType?.includes("application/json")) throw new Error("Invalid server response");
      const data = await res.json();
      localStorage.setItem("token", data.access_token);
      router.push("/dashboard");
    } catch (err: any) {
      setLoginError(err.message || "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  /**
   * Clicking "Forgot password?" auto-sends the reset request using
   * whatever identifier (username/email) is already in the login field.
   * If the field is empty, we show a gentle inline error instead of a modal.
   */
  const openForgotModal = async () => {
    const identifier = username.trim();
    if (!identifier) {
      setLoginError("Enter your username or email above, then click Forgot password?");
      return;
    }
    setLoginError("");
    setFpError("");
    setFpIdentifier(identifier);
    setResetToken(""); setResetNewPw(""); setResetConfirmPw("");
    setResetError(""); setResetSuccess(false);
    setModalStep("sending");

    try {
      const res = await fetch(`${API}/api/v1/users/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setFpError(d.detail || "Something went wrong. Please try again.");
        setModalStep("reset"); // still open modal so user sees error
        return;
      }
      setModalStep("reset");
    } catch {
      setFpError("Failed to connect to the server.");
      setModalStep("reset");
    }
  };

  const closeModal = () => {
    setModalStep("closed");
    setFpError("");
    setResetToken(""); setResetNewPw(""); setResetConfirmPw("");
    setResetError(""); setResetSuccess(false);
  };

  const handleResetSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setResetError("");
    if (!resetToken.trim()) { setResetError("Paste the token from the API server terminal."); return; }
    if (resetNewPw.length < 6) { setResetError("Password must be at least 6 characters."); return; }
    if (resetNewPw !== resetConfirmPw) { setResetError("Passwords do not match."); return; }
    setResetSubmitting(true);
    try {
      const res = await fetch(`${API}/api/v1/users/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: resetToken.trim(), new_password: resetNewPw }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        setResetError(d.detail || "Reset failed. Token may be invalid or expired.");
        return;
      }
      setResetSuccess(true);
      setTimeout(closeModal, 2500);
    } catch {
      setResetError("Failed to connect to the server.");
    } finally {
      setResetSubmitting(false);
    }
  };

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <div className="min-h-screen bg-gradient-to-br from-indigo-50 via-white to-blue-50 dark:from-gray-950 dark:via-gray-900 dark:to-gray-950 flex items-center justify-center p-6">
        <div className="w-full max-w-md">
          {/* Brand */}
          <div className="text-center mb-10 flex flex-col items-center">
            <Logo size="xl" />
            <p className="mt-3 text-lg text-gray-600 dark:text-gray-400">
              Intelligent No-Code Test Automation
            </p>
          </div>

          {/* Card */}
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
            {/* Tabs */}
            <div className="flex border-b border-gray-200 dark:border-gray-700">
              <button className="flex-1 py-4 text-center font-medium text-indigo-600 border-b-2 border-indigo-600 dark:text-indigo-400 dark:border-indigo-500">
                Login
              </button>
              <Link
                href="/signup"
                className="flex-1 py-4 text-center font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
              >
                Sign Up
              </Link>
            </div>

            {/* Form */}
            <div className="p-8">
              <form onSubmit={handleLogin} className="space-y-6">
                {/* Username */}
                <div>
                  <label htmlFor="username" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Username
                  </label>
                  <input
                    id="username"
                    type="text"
                    value={username}
                    onChange={(e) => { setUsername(e.target.value); setLoginError(""); }}
                    required
                    className="w-full px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition"
                    placeholder="johndoe123"
                  />
                </div>

                {/* Password + Forgot link */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label htmlFor="password" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                      Password
                    </label>
                    <button
                      type="button"
                      id="forgot-password-trigger"
                      onClick={openForgotModal}
                      disabled={modalStep === "sending"}
                      className="text-sm text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300 focus:outline-none disabled:opacity-50 disabled:cursor-wait"
                    >
                      {modalStep === "sending" ? "Sending…" : "Forgot password?"}
                    </button>
                  </div>
                  <input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    className="w-full px-4 py-3 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition"
                    placeholder="••••••••"
                  />
                </div>

                {/* Login / hint error */}
                {loginError && (
                  <div className="text-red-600 dark:text-red-400 text-sm text-center bg-red-50 dark:bg-red-900/30 py-2 px-4 rounded-lg">
                    {loginError}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-3 px-4 bg-indigo-600 hover:bg-indigo-700 text-white font-medium rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? "Signing in..." : "Sign In"}
                </button>
              </form>

              {/* Social */}
              <div className="mt-8">
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-gray-300 dark:border-gray-600" />
                  </div>
                  <div className="relative flex justify-center text-sm">
                    <span className="px-2 bg-white dark:bg-gray-800 text-gray-500 dark:text-gray-400">
                      Or continue with
                    </span>
                  </div>
                </div>
                <button className="mt-6 w-full py-3 px-4 border border-gray-300 dark:border-gray-600 rounded-lg font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition flex items-center justify-center gap-3">
                  <svg className="h-5 w-5" viewBox="0 0 24 24">
                    <path
                      fill="currentColor"
                      d="M12.24 10.285V14.4h6.806c-.275 1.765-2.056 5.174-6.806 5.174-4.095 0-7.44-3.39-7.44-7.56s3.345-7.56 7.44-7.56c2.33 0 3.89.935 4.785 1.74l3.254-3.138C18.189 1.186 15.479 0 12.24 0c-6.635 0-12 5.365-12 12s5.365 12 12 12c6.926 0 11.542-4.861 11.542-11.7 0-.785-.085-1.39-.185-1.995H12.24z"
                    />
                  </svg>
                  Continue with Google
                </button>
              </div>
            </div>
          </div>

          <p className="mt-8 text-center text-sm text-gray-600 dark:text-gray-400">
            Don&apos;t have an account?{" "}
            <Link href="/signup" className="font-medium text-indigo-600 hover:text-indigo-800 dark:text-indigo-400 dark:hover:text-indigo-300">
              Sign up for free
            </Link>
          </p>
        </div>
      </div>

      {/* ── Reset Password Modal (opens directly at Step 2 — no email step) ── */}
      {modalStep !== "closed" && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: "rgba(0,0,0,0.55)", backdropFilter: "blur(4px)" }}
          onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-white dark:bg-gray-900 shadow-2xl border border-gray-200 dark:border-gray-700"
            style={{ animation: "modal-in 200ms ease forwards" }}
            role="dialog"
            aria-modal="true"
          >
            {/* Header */}
            <div className="flex items-start justify-between px-6 pt-6 pb-4 border-b border-gray-100 dark:border-gray-800">
              <div>
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Reset Password</h2>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                  A reset token has been sent — check your email or the API terminal.
                </p>
              </div>
              <button
                onClick={closeModal}
                id="modal-close"
                className="ml-4 mt-0.5 rounded-lg p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors flex-shrink-0"
                aria-label="Close"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                  <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </div>

            <div className="px-6 py-5 space-y-4">
              {/* Sending spinner */}
              {modalStep === "sending" && (
                <div className="flex items-center gap-3 py-4 text-sm text-gray-600 dark:text-gray-400">
                  <svg className="w-5 h-5 animate-spin text-indigo-600" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                  </svg>
                  Generating reset token for <span className="font-medium ml-1">{fpIdentifier}</span>…
                </div>
              )}

              {/* Reset form */}
              {modalStep === "reset" && (
                <>
                  {resetSuccess ? (
                    /* Success state */
                    <div className="py-6 flex flex-col items-center gap-3 text-center">
                      <div className="w-14 h-14 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
                        <svg className="w-7 h-7 text-green-600 dark:text-green-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                          <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </div>
                      <p className="text-base font-semibold text-gray-900 dark:text-gray-100">Password Reset!</p>
                      <p className="text-sm text-gray-500 dark:text-gray-400">You can now sign in with your new password.</p>
                    </div>
                  ) : (
                    <form onSubmit={handleResetSubmit} className="space-y-4">
                      {/* Account context banner */}
                      <div className="rounded-lg bg-indigo-50 dark:bg-indigo-950/30 border border-indigo-100 dark:border-indigo-900 px-4 py-3 text-sm">
                        <div className="flex items-center gap-2">
                          <svg className="w-4 h-4 text-indigo-500 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                            <circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
                          </svg>
                          <span className="text-indigo-700 dark:text-indigo-300">
                            Resetting password for{" "}
                            <span className="font-semibold">{fpIdentifier}</span>
                          </span>
                        </div>
                        {fpError ? (
                          <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">{fpError}</p>
                        ) : (
                          <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">Check your email inbox. If SMTP isn&apos;t configured, a preview link is printed in the API server terminal.</p>
                        )}
                      </div>

                      {/* Token */}
                      <div>
                        <label htmlFor="reset-token" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                          Reset Token
                        </label>
                        <input
                          id="reset-token"
                          type="text"
                          autoFocus
                          value={resetToken}
                          onChange={(e) => { setResetToken(e.target.value); setResetError(""); }}
                          placeholder="Paste the token from your email…"
                          className="w-full px-4 py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none transition text-xs font-mono"
                        />
                      </div>

                      {/* New password */}
                      <div>
                        <label htmlFor="reset-new-pw" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                          New Password
                        </label>
                        <input
                          id="reset-new-pw"
                          type="password"
                          value={resetNewPw}
                          onChange={(e) => { setResetNewPw(e.target.value); setResetError(""); }}
                          placeholder="At least 6 characters"
                          className="w-full px-4 py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none transition text-sm"
                        />
                      </div>

                      {/* Confirm password */}
                      <div>
                        <label htmlFor="reset-confirm-pw" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                          Confirm Password
                        </label>
                        <input
                          id="reset-confirm-pw"
                          type="password"
                          value={resetConfirmPw}
                          onChange={(e) => { setResetConfirmPw(e.target.value); setResetError(""); }}
                          placeholder="Re-enter new password"
                          className="w-full px-4 py-2.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-indigo-500 outline-none transition text-sm"
                        />
                      </div>

                      {/* Field error */}
                      {resetError && (
                        <p className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/30 px-3 py-2 rounded-lg">{resetError}</p>
                      )}

                      {/* Actions */}
                      <div className="flex gap-3 pt-1">
                        <button
                          type="button"
                          onClick={closeModal}
                          className="flex-1 py-2.5 px-4 border border-gray-300 dark:border-gray-600 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition"
                        >
                          Cancel
                        </button>
                        <button
                          id="submit-reset-password"
                          type="submit"
                          disabled={resetSubmitting}
                          className="flex-1 py-2.5 px-4 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-sm font-medium transition disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {resetSubmitting ? "Resetting…" : "Reset Password"}
                        </button>
                      </div>
                    </form>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}