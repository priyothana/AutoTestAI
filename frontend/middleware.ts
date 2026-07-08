import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'

export function middleware(request: NextRequest) {
  const token = request.cookies.get('token')?.value
  const { pathname } = request.nextUrl

  // Define route types
  const isProtectedRoute = pathname.startsWith('/dashboard')
  const isAuthRoute = pathname === '/login' || pathname === '/signup' || pathname === '/'

  // Parse JWT payload safely
  const isValid = (() => {
    if (!token) return false
    try {
      const parts = token.split('.')
      if (parts.length !== 3) return false
      
      // Base64url decoding in Next.js Middleware environment (Edge-safe)
      const payloadBase64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
      const decodedPayload = atob(payloadBase64)
      const payload = JSON.parse(decodedPayload)
      
      // Check expiration
      if (payload.exp && Date.now() >= payload.exp * 1000) {
        return false
      }
      return true
    } catch {
      return false
    }
  })()

  if (isProtectedRoute && !isValid) {
    // Redirect to login if accessing a protected route without a valid token
    const loginUrl = new URL('/login', request.url)
    // Clear the invalid cookie so they don't get stuck in a weird loop
    const response = NextResponse.redirect(loginUrl)
    response.cookies.set('token', '', { maxAge: 0, path: '/' })
    return response
  }

  if (isAuthRoute && isValid) {
    // Redirect to dashboard if already logged in
    const dashboardUrl = new URL('/dashboard', request.url)
    return NextResponse.redirect(dashboardUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/dashboard/:path*', '/login', '/signup', '/'],
}
