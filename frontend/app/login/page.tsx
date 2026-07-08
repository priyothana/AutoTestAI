"use client"

import { useState, useEffect, Suspense } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card"
import { toast } from "sonner"
import Logo from "@/components/shared/Logo"

const API = process.env.NEXT_PUBLIC_API_URL

type ModalStep = "closed" | "sending" | "reset"

function LoginPageInner() {
  const router = useRouter()
  const searchParams = useSearchParams()

  // ── Login state ──────────────────────────────────────────────────────────
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [loginError, setLoginError] = useState("")
  const [loading, setLoading]       = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)

  // ── Handle OAuth callback query params on mount ───────────────────────────
  useEffect(() => {
    const token      = searchParams.get("token")
    const oauthError = searchParams.get("oauth_error")

    if (token) {
      localStorage.setItem("token", token)
      toast.success("Signed in with Google!")
      router.push("/dashboard")
      return
    }

    if (oauthError) {
      setLoginError(`Google sign-in failed: ${decodeURIComponent(oauthError)}`)
      toast.error(`Google sign-in failed: ${decodeURIComponent(oauthError)}`)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Forgot-password modal state ──────────────────────────────────────────
  const [modalStep, setModalStep]     = useState<ModalStep>("closed")
  const [fpIdentifier, setFpIdentifier] = useState("") // username captured from login field
  const [fpError, setFpError]         = useState("")

  const [resetToken, setResetToken]           = useState("")
  const [resetNewPw, setResetNewPw]           = useState("")
  const [resetConfirmPw, setResetConfirmPw]   = useState("")
  const [resetError, setResetError]           = useState("")
  const [resetSubmitting, setResetSubmitting] = useState(false)
  const [resetSuccess, setResetSuccess]       = useState(false)

  // ── Login handler ─────────────────────────────────────────────────────────
  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoginError("")
    setLoading(true)
    try {
      const res = await fetch(`${API}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ username, password }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        toast.error(`Login failed: ${err.detail || "Incorrect credentials"}`)
        setLoginError(err.detail || "Incorrect credentials")
        return
      }
      const data = await res.json()
      localStorage.setItem("token", data.access_token)
      toast.success("Login successful!")
      setTimeout(() => router.push("/dashboard"), 800)
    } catch {
      const msg = "Failed to connect to the server."
      toast.error(msg)
      setLoginError(msg)
    } finally {
      setLoading(false)
    }
  }

  /**
   * Click "Forgot password?" → auto-use the username field value,
   * call the API immediately, open the modal at the token+password step.
   * No email entry step.
   */
  const openForgotModal = async () => {
    const identifier = username.trim()
    if (!identifier) {
      setLoginError("Enter your username above first, then click Forgot password?")
      return
    }
    setLoginError("")
    setFpError("")
    setFpIdentifier(identifier)
    setResetToken(""); setResetNewPw(""); setResetConfirmPw("")
    setResetError(""); setResetSuccess(false)
    setModalStep("sending")

    try {
      const res = await fetch(`${API}/api/auth/forgot-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setFpError(d.detail || "Something went wrong. Please try again.")
      }
      setModalStep("reset")
    } catch {
      setFpError("Failed to connect to the server.")
      setModalStep("reset")
    }
  }

  const closeModal = () => {
    setModalStep("closed")
    setFpError("")
    setResetToken(""); setResetNewPw(""); setResetConfirmPw("")
    setResetError(""); setResetSuccess(false)
  }

  const handleResetSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setResetError("")
    if (!resetToken.trim()) { setResetError("Paste the token from the API server terminal."); return }
    if (resetNewPw.length < 6) { setResetError("Password must be at least 6 characters."); return }
    if (resetNewPw !== resetConfirmPw) { setResetError("Passwords do not match."); return }
    setResetSubmitting(true)
    try {
      const res = await fetch(`${API}/api/auth/reset-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: resetToken.trim(), new_password: resetNewPw }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        setResetError(d.detail || "Reset failed. Token may be invalid or expired.")
        return
      }
      setResetSuccess(true)
      toast.success("Password reset! You can now sign in.")
      setTimeout(closeModal, 2500)
    } catch {
      setResetError("Failed to connect to the server.")
    } finally {
      setResetSubmitting(false)
    }
  }

  return (
    <>
      {/* ── Login card ── */}
      <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-950 p-4">
        <Card className="w-full max-w-md shadow-lg border-0 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm">
          <CardHeader className="space-y-1">
            <div className="flex justify-center">
              <Logo size="lg" />
            </div>
            <CardDescription className="text-center">
              Enter your credentials to sign in to your account
            </CardDescription>
          </CardHeader>

          <CardContent>
            <form onSubmit={onSubmit} className="space-y-6">
              {/* Username */}
              <div className="space-y-2">
                <label htmlFor="login-username" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                  Username
                </label>
                <Input
                  id="login-username"
                  placeholder="e.g. johndoe"
                  value={username}
                  onChange={(e) => { setUsername(e.target.value); setLoginError("") }}
                />
              </div>

              {/* Password */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label htmlFor="login-password" className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
                    Password
                  </label>
                  <button
                    type="button"
                    id="forgot-password-trigger"
                    onClick={openForgotModal}
                    disabled={modalStep === "sending"}
                    className="text-xs text-primary hover:underline focus:outline-none disabled:opacity-50 disabled:cursor-wait"
                  >
                    {modalStep === "sending" ? "Sending…" : "Forgot password?"}
                  </button>
                </div>
                <Input
                  id="login-password"
                  type="password"
                  placeholder="••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>

              {/* Inline error / hint */}
              {loginError && (
                <p className="text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 px-3 py-2 rounded-lg text-center">
                  {loginError}
                </p>
              )}

              <Button
                id="login-submit"
                type="submit"
                className="w-full bg-blue-600 hover:bg-blue-700 text-white"
                disabled={loading}
              >
                {loading ? "Signing in…" : "Sign In"}
              </Button>
            </form>

            {/* Divider */}
            <div className="relative my-4">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-background px-2 text-muted-foreground">Or continue with</span>
              </div>
            </div>

            {/* Google OAuth button */}
            <Button
              id="google-signin-btn"
              variant="outline"
              className="w-full flex items-center justify-center gap-3 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              disabled={googleLoading}
              onClick={() => {
                setGoogleLoading(true)
                window.location.href = `${API}/api/auth/google`
              }}
            >
              {googleLoading ? (
                <svg className="w-4 h-4 animate-spin text-gray-500" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
              ) : (
                <svg className="w-5 h-5" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                  <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                  <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                  <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
                  <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                </svg>
              )}
              {googleLoading ? "Redirecting…" : "Continue with Google"}
            </Button>
          </CardContent>

          <CardFooter className="flex justify-center text-sm text-muted-foreground">
            Don&apos;t have an account?
            <Link href="/signup" className="ml-1 font-medium text-primary hover:underline">
              Sign up
            </Link>
          </CardFooter>
        </Card>
      </div>

      {/* ── Reset Password Modal — opens DIRECTLY at token+password (no email step) ── */}
      {modalStep !== "closed" && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ backgroundColor: "rgba(0,0,0,0.55)", backdropFilter: "blur(4px)" }}
          onClick={(e) => { if (e.target === e.currentTarget) closeModal() }}
        >
          <div
            className="w-full max-w-md rounded-2xl bg-white dark:bg-gray-900 shadow-2xl border border-gray-200 dark:border-gray-700 modal-enter"
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
                  <svg className="w-5 h-5 animate-spin text-blue-600" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                  </svg>
                  Generating reset token for <span className="font-semibold ml-1">{fpIdentifier}</span>…
                </div>
              )}

              {/* Reset form */}
              {modalStep === "reset" && (
                <>
                  {resetSuccess ? (
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
                      {/* Account banner */}
                      <div className="rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-100 dark:border-blue-900 px-4 py-3 text-sm">
                        <div className="flex items-center gap-2">
                          <svg className="w-4 h-4 text-blue-500 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                            <circle cx="12" cy="8" r="4" /><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7" />
                          </svg>
                          <span className="text-blue-700 dark:text-blue-300">
                            Resetting password for <span className="font-semibold">{fpIdentifier}</span>
                          </span>
                        </div>
                        {fpError ? (
                          <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">{fpError}</p>
                        ) : (
                          <p className="mt-1.5 text-xs text-gray-500 dark:text-gray-400">
                            Check your email inbox. If SMTP isn&apos;t configured, a preview link is printed in the API server terminal.
                          </p>
                        )}
                      </div>

                      {/* Token */}
                      <div className="space-y-1.5">
                        <label htmlFor="reset-token" className="text-sm font-medium text-gray-700 dark:text-gray-300">
                          Reset Token
                        </label>
                        <Input
                          id="reset-token"
                          autoFocus
                          value={resetToken}
                          onChange={(e) => { setResetToken(e.target.value); setResetError("") }}
                          placeholder="Paste the token from your email…"
                          className="font-mono text-xs"
                        />
                      </div>

                      {/* New password */}
                      <div className="space-y-1.5">
                        <label htmlFor="reset-new-pw" className="text-sm font-medium text-gray-700 dark:text-gray-300">
                          New Password
                        </label>
                        <Input
                          id="reset-new-pw"
                          type="password"
                          value={resetNewPw}
                          onChange={(e) => { setResetNewPw(e.target.value); setResetError("") }}
                          placeholder="At least 6 characters"
                        />
                      </div>

                      {/* Confirm password */}
                      <div className="space-y-1.5">
                        <label htmlFor="reset-confirm-pw" className="text-sm font-medium text-gray-700 dark:text-gray-300">
                          Confirm Password
                        </label>
                        <Input
                          id="reset-confirm-pw"
                          type="password"
                          value={resetConfirmPw}
                          onChange={(e) => { setResetConfirmPw(e.target.value); setResetError("") }}
                          placeholder="Re-enter new password"
                        />
                      </div>

                      {/* Error */}
                      {resetError && (
                        <p className="text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/30 px-3 py-2 rounded-lg">
                          {resetError}
                        </p>
                      )}

                      {/* Actions */}
                      <div className="flex gap-3 pt-1">
                        <Button type="button" variant="outline" className="flex-1" onClick={closeModal}>
                          Cancel
                        </Button>
                        <Button
                          id="submit-reset-password"
                          type="submit"
                          className="flex-1 bg-blue-600 hover:bg-blue-700 text-white"
                          disabled={resetSubmitting}
                        >
                          {resetSubmitting ? "Resetting…" : "Reset Password"}
                        </Button>
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
  )
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  )
}
