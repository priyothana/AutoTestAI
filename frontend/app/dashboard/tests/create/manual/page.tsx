"use client"
import { useRouter } from "next/navigation"
import { useEffect } from "react"

// Manual test creation opens the existing test editor pre-set to Manual source mode.
// Passing ?source=manual hides the Jira import option and pre-selects the manual flow.
export default function ManualCreateRedirect() {
  const router = useRouter()
  useEffect(() => { router.replace("/dashboard/tests/new?source=manual") }, [])
  return null
}
