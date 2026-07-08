"use client"

import { useEffect } from "react"

export default function AuthInterceptor() {
  useEffect(() => {
    if (typeof window !== "undefined") {
      const originalFetch = window.fetch
      window.fetch = async (input, init) => {
        let url = ""
        if (typeof input === "string") {
          url = input
        } else if (input instanceof URL) {
          url = input.href
        } else {
          url = input.url
        }

        const apiURL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000"
        
        // If request is directed to the backend API
        if (url.startsWith(apiURL) || url.startsWith("/api/")) {
          const token = localStorage.getItem("token")
          if (token) {
            init = init || {}
            
            // Re-create headers object safely
            const headers = new Headers(init.headers || {})
            if (!headers.has("Authorization")) {
              headers.set("Authorization", `Bearer ${token}`)
            }
            
            init.headers = headers
          }
        }
        
        return originalFetch(input, init)
      }
    }
  }, [])

  return null
}
