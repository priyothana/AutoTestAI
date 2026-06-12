"use client"

import { useState, useEffect, use, useRef } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
    ArrowLeft, Loader2, Settings, FileText, BarChart3, Link2,
    Cloud, Globe, Check, X, RefreshCw, Unplug, Plug, AlertCircle,
    Key, Server, ExternalLink, Clock, Database, Search, Plus, Trash2, Edit, Play, Zap, Sparkles,
    UploadCloud, BookOpen, TestTube2, CheckCircle2, FileType, FileSpreadsheet, FolderOpen
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { toast } from "sonner"
import Link from "next/link"
import GenerateTestCasesTab from "@/components/projects/GenerateTestCasesTab"

interface Project {
    id: string
    name: string
    description: string
    type: string
    category: string
    status: string
    base_url: string
    tags: string[]
    created_at: string
    updated_at: string
}

interface IntegrationStatus {
    id?: string
    project_id?: string
    category: string | null
    status: string
    base_url?: string
    instance_url?: string
    login_strategy?: string
    org_id?: string
    salesforce_login_url?: string
    has_sf_credentials?: boolean
    mcp_connected?: boolean
    last_synced_at?: string
    sync_error?: string
    auth_config?: Record<string, unknown>
    sync_counts?: {
        raw_count: number
        normalized_count: number
        domain_model_count: number
        embedding_count: number
    }
    ui_session?: {
        active: boolean
        status: string
        source: string | null
        last_created_at: string | null
    }
    /** Decrypted web app credentials returned by the API for pre-filling the form.
     *  Password is intentionally never included. */
    web_credentials?: {
        username: string | null
        login_url: string | null
    } | null
}

export default function ProjectDetailsPage({ params }: { params: Promise<{ id: string }> }) {
    const { id } = use(params)
    const router = useRouter()
    const searchParams = useSearchParams()
    const [project, setProject] = useState<Project | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [integration, setIntegration] = useState<IntegrationStatus | null>(null)
    const [integrationLoading, setIntegrationLoading] = useState(false)
    const [syncing, setSyncing] = useState(false)
    const [disconnecting, setDisconnecting] = useState(false)
    const [syncCompleted, setSyncCompleted] = useState<{
        pages_crawled: number
        normalized_count: number
        domain_model_count: number
        embedding_count: number
        completed_at: string
    } | null>(null)
    const [syncProgress, setSyncProgress] = useState<{
        active_stage: number | null
        raw_count: number
        normalized_count: number
        domain_model_count: number
        embedding_count: number
    } | null>(null)
    const [crawlProgress, setCrawlProgress] = useState<{
        crawledSoFar: number
        totalDiscovered: number
        hasMorePages: boolean
        progressMessage: string | null
    } | null>(null)
    const syncPollRef = useRef<ReturnType<typeof setInterval> | null>(null)

    // ── Test Data state ─────────────────────────────────────────────────────────────────
    const [testDataEntities, setTestDataEntities] = useState<Array<{
        entity_name: string
        record_count: number
        source: string
        last_extracted_at: string
    }>>([]) 
    const [testDataLoading, setTestDataLoading]       = useState(false)
    const [testDataExtracting, setTestDataExtracting] = useState(false)
    const [testDataUploading, setTestDataUploading]   = useState(false)
    const [uploadResult, setUploadResult] = useState<{
        success: boolean
        message: string
        preview?: Record<string, number>
    } | null>(null)
    const [uploadError, setUploadError]     = useState<string | null>(null)
    const fileInputRef = useRef<HTMLInputElement>(null)

    // MCP Connection Form (used when already connected, for MCP-only reconnect)
    const [mcpUsername, setMcpUsername] = useState("")
    const [mcpPassword, setMcpPassword] = useState("")
    const [mcpSecurityToken, setMcpSecurityToken] = useState("")
    const [mcpDomain, setMcpDomain] = useState("login")
    const [mcpConnecting, setMcpConnecting] = useState(false)

    // Inline unified Salesforce connect form (shown in Integration tab when not connected)
    const [sfIUsername, setSfIUsername] = useState("")
    const [sfIPassword, setSfIPassword] = useState("")
    const [sfISecurityToken, setSfISecurityToken] = useState("")
    const [sfIClientId, setSfIClientId] = useState("")
    const [sfIClientSecret, setSfIClientSecret] = useState("")
    const [sfILoginUrl, setSfILoginUrl] = useState("https://login.salesforce.com")
    const [sfIRedirectUri] = useState(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/integrations/salesforce/callback`)
    const [sfIShowPassword, setSfIShowPassword] = useState(false)
    const [sfIShowToken, setSfIShowToken] = useState(false)
    const [sfIShowSecret, setSfIShowSecret] = useState(false)
    const [sfIUsernameErr, setSfIUsernameErr] = useState<string | null>(null)
    const [sfIPasswordErr, setSfIPasswordErr] = useState<string | null>(null)
    const [sfIClientIdErr, setSfIClientIdErr] = useState<string | null>(null)
    const [sfIClientSecretErr, setSfIClientSecretErr] = useState<string | null>(null)
    const [sfIConnectError, setSfIConnectError] = useState<string | null>(null)
    const [sfIConnecting, setSfIConnecting] = useState(false)
    const [sfISuccess, setSfISuccess] = useState<{ oAuth: boolean; mcp: boolean; sync: boolean } | null>(null)

    // MCP CRUD State
    const [soqlQuery, setSoqlQuery] = useState("SELECT Id, Name FROM Account LIMIT 10")
    const [queryResults, setQueryResults] = useState<any>(null)
    const [queryLoading, setQueryLoading] = useState(false)
    const [createObjectType, setCreateObjectType] = useState("Account")
    const [createData, setCreateData] = useState('{"Name": "Test Account"}')
    const [createLoading, setCreateLoading] = useState(false)
    const [updateObjectType, setUpdateObjectType] = useState("Account")
    const [updateRecordId, setUpdateRecordId] = useState("")
    const [updateData, setUpdateData] = useState('{"Name": "Updated Name"}')
    const [updateLoading, setUpdateLoading] = useState(false)
    const [deleteObjectType, setDeleteObjectType] = useState("Account")
    const [deleteRecordId, setDeleteRecordId] = useState("")
    const [deleteLoading, setDeleteLoading] = useState(false)
    const [crudTab, setCrudTab] = useState("query")
    const [orgLimits, setOrgLimits] = useState<any>(null)
    const [limitsLoading, setLimitsLoading] = useState(false)
    const [mcpSyncing, setMcpSyncing] = useState(false)

    // Jira Integration
    const [jiraConfig, setJiraConfig] = useState<any>(null)
    const [jiraConfigLoading, setJiraConfigLoading] = useState(false)
    const [jiraDomain, setJiraDomain] = useState("")
    const [jiraEmail, setJiraEmail] = useState("")
    const [jiraApiToken, setJiraApiToken] = useState("")
    const [jiraConnecting, setJiraConnecting] = useState(false)
    const [jiraConnected, setJiraConnected] = useState(false)
    const [jiraBoards, setJiraBoards] = useState<{id: string; name: string}[]>([])
    const [selectedJiraBoard, setSelectedJiraBoard] = useState("")
    const [selectedJiraBoardName, setSelectedJiraBoardName] = useState("")
    const [jiraSaving, setJiraSaving] = useState(false)
    const [jiraReconfiguring, setJiraReconfiguring] = useState(false)
    const [jiraConnectError, setJiraConnectError] = useState<string | null>(null)

    // Web App Session & Login Credentials
    const [webLoginUrl, setWebLoginUrl] = useState("")
    const [webUsername, setWebUsername] = useState("")
    const [webPassword, setWebPassword] = useState("")
    const [webShowPassword, setWebShowPassword] = useState(false)
    const [webLoginStrategy, setWebLoginStrategy] = useState("form")
    const [webCredSaving, setWebCredSaving] = useState(false)
    const [webCredSuccess, setWebCredSuccess] = useState(false)

    // ── Keycloak / OAuth Custom Token state ───────────────────────────────
    // Keycloak tokens are short-lived — we never pre-fill them from the server
    // (the API intentionally never returns raw token values for security).
    const [kcAuthToken, setKcAuthToken] = useState("")
    const [kcIdToken, setKcIdToken] = useState("")
    const [kcRefreshUrl, setKcRefreshUrl] = useState("")
    const [kcShowAuthToken, setKcShowAuthToken] = useState(false)
    const [kcShowIdToken, setKcShowIdToken] = useState(false)
    const [kcSaving, setKcSaving] = useState(false)
    const [kcSuccess, setKcSuccess] = useState(false)
    const [kcSessionStatus, setKcSessionStatus] = useState<{
        configured: boolean
        status?: "valid" | "expiring_soon" | "expired"
        is_expired?: boolean
        is_near_expiry?: boolean
        expires_at?: number
        expires_at_iso?: string
        ms_remaining?: number
        has_id_token?: boolean
        refresh_url?: string | null
    } | null>(null)

    // ── Document Upload State ────────────────────────────────────────────────
    type UploadedDoc = { id: string; name: string; size: number; type: string; uploadedAt: string }
    const [brdDocs, setBrdDocs] = useState<UploadedDoc[]>([])
    const [testCaseDocs, setTestCaseDocs] = useState<UploadedDoc[]>([])
    const [brdUploading, setBrdUploading] = useState(false)
    const [testCaseUploading, setTestCaseUploading] = useState(false)
    const [brdDragOver, setBrdDragOver] = useState(false)
    const [testCaseDragOver, setTestCaseDragOver] = useState(false)
    const brdFileInputRef = useRef<HTMLInputElement>(null)
    const testCaseFileInputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        if (id) {
            fetchProject()
            fetchIntegration()
            fetchJiraConfig()
            loadTestData()
            loadPersistedDocs()
            fetchKeycloakSessionStatus()
        }
        const connected = searchParams.get("connected")
        if (connected === "salesforce") toast.success("Salesforce connected & metadata sync started!")
        const error = searchParams.get("error")
        if (error) toast.error(`Connection error: ${error}`)
    }, [id])

    /** Load previously saved BRD and existing-test-case docs from the API on mount */
    const loadPersistedDocs = async () => {
        try {
            const [brdRes, tcRes] = await Promise.all([
                fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${id}/brd`),
                fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${id}/existing-tests`),
            ])
            if (brdRes.ok) {
                const data = await brdRes.json()
                if (data.attached && data.filename) {
                    setBrdDocs([{
                        id: 'brd-persisted',
                        name: data.filename,
                        size: data.bytes ?? 0,
                        type: 'application/octet-stream',
                        uploadedAt: new Date().toISOString(),
                    }])
                }
            }
            if (tcRes.ok) {
                const data = await tcRes.json()
                if (data.attached && data.filename) {
                    setTestCaseDocs([{
                        id: 'tc-persisted',
                        name: data.filename,
                        size: data.bytes ?? 0,
                        type: 'application/octet-stream',
                        uploadedAt: new Date().toISOString(),
                    }])
                }
            }
        } catch (e) {
            console.error('Failed to load persisted docs:', e)
        }
    }


    const fetchJiraConfig = async () => {
        setJiraConfigLoading(true)
        try {
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/jira/projects/${id}/config`)
            if (res.ok) {
                const data = await res.json()
                if (data.configured) setJiraConfig(data)
            }
        } catch (e) { console.error("Failed to fetch Jira config:", e) }
        finally { setJiraConfigLoading(false) }
    }

    const handleJiraConnect = async () => {
        if (!jiraDomain || !jiraEmail || !jiraApiToken) { toast.error("Please fill in all Jira fields"); return }
        setJiraConnecting(true)
        setJiraConnectError(null)
        try {
            // Step 1: Validate credentials
            let connectRes: Response
            try {
                connectRes = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/jira/connect`, {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    // Node.js schema requires: jira_domain, jira_email, jira_token
                    body: JSON.stringify({ jira_domain: jiraDomain, jira_email: jiraEmail, jira_token: jiraApiToken }),
                })
            } catch (networkErr: any) {
                throw new Error(`Network error: Cannot reach the backend server. Is it running? (${networkErr.message})`)
            }
            if (!connectRes.ok) {
                let errMsg = "Connection failed"
                try {
                    const err = await connectRes.json()
                    errMsg = err.detail || err.message || errMsg
                } catch { /* ignore parse error */ }
                throw new Error(errMsg)
            }

            // Step 2: Fetch boards
            let boardsRes: Response
            try {
                boardsRes = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/jira/boards`, {
                    method: "POST", headers: { "Content-Type": "application/json" },
                    // Node.js schema requires: jira_domain, jira_email, jira_token
                    body: JSON.stringify({ jira_domain: jiraDomain, jira_email: jiraEmail, jira_token: jiraApiToken }),
                })
            } catch (networkErr: any) {
                throw new Error(`Network error fetching boards: ${networkErr.message}`)
            }
            if (!boardsRes.ok) {
                let errMsg = "Failed to fetch boards"
                try {
                    const err = await boardsRes.json()
                    errMsg = err.detail || err.message || errMsg
                } catch { /* ignore parse error */ }
                throw new Error(errMsg)
            }

            const data = await boardsRes.json().catch(() => null)
            if (!data) throw new Error("Boards response was not valid JSON. Check that the backend is running correctly.")
            const boards = data.boards || []
            if (boards.length === 0) {
                toast.warning("Connected, but no boards found. Make sure your Jira account has access to at least one board.")
            } else {
                toast.success(`Connected to Jira! Found ${boards.length} board${boards.length > 1 ? "s" : ""}.`)
            }
            setJiraBoards(boards)
            setJiraConnected(true)
            if (boards.length > 0) { setSelectedJiraBoard(boards[0].id); setSelectedJiraBoardName(boards[0].name) }
        } catch (error: any) {
            const msg = error.message || "Jira connection failed"
            setJiraConnectError(msg)
            toast.error(msg, { duration: 8000 })
        }
        finally { setJiraConnecting(false) }
    }

    const handleSaveJiraConfig = async () => {
        if (!selectedJiraBoard) { toast.error("Select a board first"); return }
        setJiraSaving(true)
        try {
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/jira/projects/${id}/config`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                // Node.js schema requires: jira_domain, jira_email, jira_token, board_id, board_name
                body: JSON.stringify({ jira_domain: jiraDomain, jira_email: jiraEmail, jira_token: jiraApiToken, board_id: selectedJiraBoard, board_name: selectedJiraBoardName }),
            })
            if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.detail || "Save failed") }
            toast.success("Jira configuration saved!")
            setJiraReconfiguring(false)
            fetchJiraConfig()
        } catch (error: any) { toast.error(error.message || "Failed to save") }
        finally { setJiraSaving(false) }
    }

    const handleSaveWebCredentials = async () => {
        if (!webLoginUrl && !webUsername && !webPassword) {
            toast.error("Fill in at least one field to save")
            return
        }
        setWebCredSaving(true)
        setWebCredSuccess(false)
        try {
            const body: Record<string, string> = { login_strategy: webLoginStrategy }
            if (webLoginUrl.trim()) body.login_url = webLoginUrl.trim()
            if (webUsername.trim()) body.username = webUsername.trim()
            if (webPassword) body.password = webPassword

            const res = await fetch(
                `${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${id}/save-web-credentials`,
                { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
            )
            if (!res.ok) {
                const err = await res.json().catch(() => ({}))
                throw new Error(err.detail || "Failed to save credentials")
            }
            setWebCredSuccess(true)
            setWebPassword("")
            fetchIntegration()
            toast.success("✅ Web app credentials saved — login will be used on next test run")
            setTimeout(() => setWebCredSuccess(false), 5000)
        } catch (err: any) {
            toast.error(err.message || "Failed to save credentials")
        } finally {
            setWebCredSaving(false)
        }
    }

    /**
     * Fetch the current Keycloak session status from the API.
     * Called on mount and after saving tokens.
     */
    const fetchKeycloakSessionStatus = async () => {
        try {
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${id}/keycloak-session`)
            if (res.ok) setKcSessionStatus(await res.json())
        } catch { /* non-critical */ }
    }

    /**
     * Save Keycloak auth_token + id_token to the backend.
     * The tokens are Fernet-encrypted and stored in auth_config.
     * Calling this also sets login_strategy='keycloak' on the integration.
     */
    const handleSaveKeycloakTokens = async () => {
        if (!kcAuthToken.trim()) {
            toast.error("auth_token is required")
            return
        }
        setKcSaving(true)
        setKcSuccess(false)
        try {
            const body: Record<string, string | number> = {
                auth_token: kcAuthToken.trim(),
            }
            if (kcIdToken.trim()) body.id_token = kcIdToken.trim()
            if (kcRefreshUrl.trim()) body.refresh_url = kcRefreshUrl.trim()
            // Default 24h expiry from now (Unix ms)
            body.expires_at = Date.now() + 24 * 60 * 60 * 1000

            const res = await fetch(
                `${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${id}/save-keycloak-tokens`,
                { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
            )
            if (!res.ok) {
                const err = await res.json().catch(() => ({}))
                throw new Error(err.detail || err.message || "Failed to save Keycloak tokens")
            }
            setKcSuccess(true)
            setKcAuthToken("")
            setKcIdToken("")
            fetchIntegration()
            fetchKeycloakSessionStatus()
            toast.success("✅ Keycloak tokens saved — session ready for test execution")
            setTimeout(() => setKcSuccess(false), 5000)
        } catch (err: any) {
            toast.error(err.message || "Failed to save Keycloak tokens")
        } finally {
            setKcSaving(false)
        }
    }

    const handleClearKeycloakSession = async () => {
        try {
            const res = await fetch(
                `${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${id}/keycloak-session`,
                { method: "DELETE" }
            )
            if (!res.ok) throw new Error("Failed to clear session")
            setKcSessionStatus(null)
            setWebLoginStrategy("form")
            fetchIntegration()
            toast.success("Keycloak session cleared")
        } catch (err: any) {
            toast.error(err.message || "Failed to clear session")
        }
    }

    const fetchProject = async () => {
        try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${id}`)
            if (!response.ok) throw new Error("Failed to fetch project")
            setProject(await response.json())
        } catch { toast.error("Failed to load project") }
        finally { setIsLoading(false) }
    }

    const fetchIntegration = async () => {
        setIntegrationLoading(true)
        try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${id}/integration-status`)
            if (response.ok) {
                const data = await response.json()
                setIntegration(data)

                // Pre-populate the Session & Login form with credentials saved
                // during project creation, so the user doesn't have to retype them.
                // Password is intentionally never returned by the API.
                if (data.web_credentials) {
                    if (data.web_credentials.username) setWebUsername(data.web_credentials.username)
                    if (data.web_credentials.login_url) setWebLoginUrl(data.web_credentials.login_url)
                }
                if (data.login_strategy) setWebLoginStrategy(data.login_strategy)
            }
        } catch (error) { console.error("Failed to fetch integration:", error) }
        finally { setIntegrationLoading(false) }
    }

    const handleSyncMetadata = async () => {
        setSyncing(true)
        setSyncCompleted(null)
        setSyncProgress({ active_stage: 1, raw_count: 0, normalized_count: 0, domain_model_count: 0, embedding_count: 0 })
        try {
            // Route to the correct sync endpoint based on integration type
            const isMcpConn = integration?.mcp_connected
            const isWebAppIntegration = !isMcpConn && integration?.category !== "salesforce" && integration?.category !== "api"

            const url = isMcpConn
                ? `${process.env.NEXT_PUBLIC_API_URL}/api/v1/mcp/projects/${id}/mcp/sync-metadata`
                : isWebAppIntegration
                    ? `${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${id}/sync-webapp-metadata`
                    : `${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${id}/sync-metadata`

            const response = await fetch(url, { method: "POST" })
            const data = await response.json()

            if (data.status === "completed") {
                // Inline sync completed immediately
                setSyncing(false)
                setSyncProgress(null)
                const pagesCrawled = data.pages_crawled ?? data.raw_count ?? 0
                setSyncCompleted({
                    pages_crawled: pagesCrawled,
                    normalized_count: data.normalized_count || 0,
                    domain_model_count: data.domain_model_count || 0,
                    embedding_count: data.embedding_count || 0,
                    completed_at: new Date().toISOString(),
                })
                toast.success(`✅ Metadata synced! ${pagesCrawled} pages crawled, ${data.embedding_count || 0} embeddings created.`)
                setTimeout(() => fetchIntegration(), 2000)
                setTimeout(() => setSyncCompleted(null), 10000)
            } else if (data.status === "queued") {
                // Job queued in BullMQ — start polling for live progress
                if (isWebAppIntegration) {
                    startSyncPolling()
                } else {
                    setSyncing(false)
                    setSyncProgress(null)
                    toast.success("🕐 Sync queued — running in the background. Refresh in a few moments.")
                    setTimeout(() => fetchIntegration(), 3000)
                }
            } else {
                setSyncing(false)
                setSyncProgress(null)
                toast.error(data.message || "Sync failed")
            }
        } catch {
            setSyncing(false)
            setSyncProgress(null)
            toast.error("Sync request failed")
        }
    }

    const startSyncPolling = () => {
        // Clear any existing poll
        if (syncPollRef.current) clearInterval(syncPollRef.current)
        let consecutiveDoneChecks = 0

        syncPollRef.current = setInterval(async () => {
            try {
                const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${id}/sync-status`)
                if (!res.ok) return
                const status = await res.json()

                setSyncProgress({
                    active_stage: status.active_stage,
                    raw_count: status.raw_count,
                    normalized_count: status.normalized_count,
                    domain_model_count: status.domain_model_count,
                    embedding_count: status.embedding_count,
                })

                // Update crawl-specific progress fields
                if (status.has_more_pages || status.crawled_so_far > 0) {
                    setCrawlProgress({
                        crawledSoFar:    status.crawled_so_far ?? 0,
                        totalDiscovered: status.total_discovered ?? 0,
                        hasMorePages:    status.has_more_pages ?? false,
                        progressMessage: status.progress_message ?? null,
                    })
                }

                // Done: last_synced_at set AND embeddings exist AND crawl is no longer running
                // NOTE: has_more_pages=true means the crawler is still processing continuation jobs;
                // stale embeddings from a previous sync must NOT trigger a false "done" here.
                const isDone = status.last_synced_at != null && status.embedding_count > 0 && !status.has_more_pages

                if (isDone) {
                    consecutiveDoneChecks++
                    // Wait for 2 consecutive done checks before declaring complete
                    if (consecutiveDoneChecks >= 2) {
                        clearInterval(syncPollRef.current!)
                        syncPollRef.current = null
                        setSyncing(false)
                        setSyncProgress(null)
                        setCrawlProgress(null)
                        const totalPages = status.pages_crawled > 0
                            ? status.pages_crawled
                            : status.crawled_so_far > 0
                                ? status.crawled_so_far
                                : status.raw_count
                        setSyncCompleted({
                            pages_crawled: totalPages,
                            normalized_count: status.normalized_count,
                            domain_model_count: status.domain_model_count,
                            embedding_count: status.embedding_count,
                            completed_at: new Date().toISOString(),
                        })
                        toast.success(`✅ Metadata sync complete! ${totalPages} pages crawled, ${status.embedding_count} embeddings created.`)
                        fetchIntegration()
                        setTimeout(() => setSyncCompleted(null), 10000)
                    }
                } else {
                    consecutiveDoneChecks = 0
                }
            } catch { /* ignore poll errors */ }
        }, 3000)

        // Safety timeout: stop polling after 10 minutes
        setTimeout(() => {
            if (syncPollRef.current) {
                clearInterval(syncPollRef.current)
                syncPollRef.current = null
                setSyncing(false)
                setSyncProgress(null)
                fetchIntegration()
                toast.info("Sync is taking longer than expected — check back soon.")
            }
        }, 10 * 60 * 1000)
    }

    // ── Test Data handlers ─────────────────────────────────────────────────────
    const loadTestData = async () => {
        if (!id) return
        setTestDataLoading(true)
        try {
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${id}/test-data`)
            if (res.ok) {
                const data = await res.json()
                setTestDataEntities(data.entities ?? [])
            }
        } catch { /* non-critical — silent fail */ }
        finally { setTestDataLoading(false) }
    }

    const handleExtractTestData = async () => {
        setTestDataExtracting(true)
        setUploadResult(null)
        setUploadError(null)
        try {
            const res = await fetch(
                `${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${id}/test-data/extract`,
                { method: 'POST' }
            )
            const data = await res.json()

            if (res.status === 202) {
                // Background extraction started — poll for results
                toast.success('Scraping your app... Check back shortly for results.', { duration: 6000 })

                // Poll GET /test-data every 5 seconds for up to 90 seconds
                const startCount = testDataEntities.length
                let lastCount = startCount
                let consecutiveNoChange = 0
                let attempts = 0
                const maxAttempts = 18  // 18 × 5s = 90s

                const pollInterval = setInterval(async () => {
                    attempts++
                    try {
                        const pollRes = await fetch(
                            `${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${id}/test-data`
                        )
                        if (pollRes.ok) {
                            const pollData = await pollRes.json()
                            const newCount = (pollData.entities ?? []).length
                            
                            // Always update the UI to show partial progress
                            setTestDataEntities(pollData.entities ?? [])

                            if (newCount > startCount) {
                                if (newCount > lastCount) {
                                    lastCount = newCount
                                    consecutiveNoChange = 0 // reset counter as we found more
                                } else {
                                    consecutiveNoChange++
                                    // If no new entities found for 3 consecutive polls (15s), assume done
                                    if (consecutiveNoChange >= 3) {
                                        clearInterval(pollInterval)
                                        setTestDataExtracting(false)
                                        toast.success(`✅ Extracted ${newCount} ${newCount === 1 ? 'entity' : 'entities'} from your app!`)
                                        return
                                    }
                                }
                            }
                        }
                    } catch { /* ignore poll errors */ }

                    if (attempts >= maxAttempts) {
                        clearInterval(pollInterval)
                        setTestDataExtracting(false)
                        // Do one final load to pick up any results
                        await loadTestData()
                        if (lastCount > startCount) {
                            toast.success(`✅ Extracted ${lastCount} entities! (Polling finished)`)
                        } else {
                            toast.error('No extractable tables found. Try uploading a JSON file instead.')
                        }
                    }
                }, 5000)

            } else if (res.ok) {
                // Synchronous response (legacy) — immediate result
                toast.success(data.message || `Extracted ${data.entities_found} entities`)
                await loadTestData()
                setTestDataExtracting(false)
            } else {
                toast.error(data.detail || data.message || 'Extraction failed')
                setTestDataExtracting(false)
            }
        } catch {
            toast.error('Failed to extract test data')
            setTestDataExtracting(false)
        }
    }

    const handleClearTestData = async () => {
        if (!confirm('Remove all test data entities for this project? This cannot be undone.')) return
        try {
            const res = await fetch(
                `${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${id}/test-data`,
                { method: 'DELETE' }
            )
            const data = await res.json()
            if (res.ok) {
                setTestDataEntities([])
                toast.success(data.message || 'All test data cleared')
            } else {
                toast.error(data.detail || 'Failed to clear test data')
            }
        } catch {
            toast.error('Failed to clear test data')
        }
    }

    const handleDeleteTestDataEntity = async (entityName: string) => {
        try {
            const res = await fetch(
                `${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${id}/test-data/${encodeURIComponent(entityName)}`,
                { method: 'DELETE' }
            )
            if (res.ok) {
                setTestDataEntities((prev: any[]) => prev.filter((e: any) => e.entity_name !== entityName))
                toast.success(`Removed entity "${entityName}"`)
            } else {
                const data = await res.json()
                toast.error(data.detail || `Failed to remove "${entityName}"`)
            }
        } catch {
            toast.error(`Failed to remove "${entityName}"`)
        }
    }

    const handleTestDataFileUpload = async (file: File) => {
        setUploadResult(null)
        setUploadError(null)


        // Validate it's a JSON file
        if (!file.name.endsWith('.json') && file.type !== 'application/json') {
            setUploadError('Please upload a valid .json file')
            return
        }

        setTestDataUploading(true)
        try {
            const text = await file.text()
            let payload: Record<string, Record<string, unknown>[]>
            try {
                payload = JSON.parse(text)
            } catch {
                setUploadError('Invalid JSON — please check your file format')
                return
            }

            // Basic validation: must be an object with at least one array value
            const entities = Object.entries(payload).filter(([, v]) => Array.isArray(v))
            if (entities.length === 0) {
                setUploadError('JSON must have the shape: { "EntityName": [{ field: value }] }')
                return
            }

            const res = await fetch(
                `${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${id}/test-data/upload`,
                {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ data: payload }),
                }
            )
            const data = await res.json()

            if (res.ok) {
                setUploadResult({
                    success: true,
                    message: data.message || `Uploaded ${data.entities_stored} entities`,
                    preview: data.preview,
                })
                await loadTestData()
            } else {
                setUploadResult({
                    success: false,
                    message: data.detail || 'Upload failed — please check the file format',
                })
            }
        } catch {
            setUploadError('Upload failed — unexpected error')
        } finally {
            setTestDataUploading(false)
        }
    }

    // ── Document Upload Handlers ─────────────────────────────────────────────
    const ACCEPTED_BRD_TYPES = [
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'text/plain',
    ]
    const ACCEPTED_BRD_EXTS = ['.pdf', '.doc', '.docx', '.txt']

    const ACCEPTED_TC_TYPES = [
        'text/csv',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]
    const ACCEPTED_TC_EXTS = ['.csv', '.xls', '.xlsx', '.doc', '.docx']

    const formatFileSize = (bytes: number) => {
        if (bytes < 1024) return `${bytes} B`
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    }

    const getDocIcon = (name: string) => {
        const ext = name.split('.').pop()?.toLowerCase()
        if (ext === 'pdf') return <span className="text-red-500">📄</span>
        if (ext === 'csv') return <span className="text-green-600">📊</span>
        if (['xls', 'xlsx'].includes(ext || '')) return <span className="text-emerald-600">📊</span>
        if (['doc', 'docx'].includes(ext || '')) return <span className="text-blue-500">📝</span>
        return <span className="text-gray-400">📎</span>
    }

    /**
     * Read a file safely for JSON transport:
     * - .txt files → UTF-8 text (AI-readable, truncated to 200 KB)
     * - binary files (PDF, DOCX, XLS, CSV…) → base64 via readAsDataURL
     *   (always valid JSON, never corrupts the HTTP body)
     */
    const readFileContent = (file: File): Promise<string> =>
        new Promise((resolve, reject) => {
            const isText = file.type === 'text/plain' || file.name.toLowerCase().endsWith('.txt')
            const reader = new FileReader()
            reader.onerror = () => reject(new Error('FileReader failed to read the file'))

            if (isText) {
                // Plain text — slice to 200 KB so it stays within backend limit
                reader.onload = e => resolve((e.target?.result as string) ?? '')
                reader.readAsText(file.slice(0, 200_000))
            } else {
                // Binary file — encode as base64 via Data URL
                // Data URL format: "data:<mime>;base64,<content>"
                // We slice to 150 KB of binary → ~200 KB base64 after encoding
                reader.onload = e => {
                    const dataUrl = (e.target?.result as string) ?? ''
                    // Strip the "data:...;base64," prefix — keep only the base64 payload
                    const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl
                    resolve(base64)
                }
                reader.readAsDataURL(file.slice(0, 150_000))
            }
        })

    const handleBrdFileUpload = async (files: FileList | null) => {
        if (!files || files.length === 0) return
        setBrdUploading(true)
        // Only take the last file — backend stores one BRD per project
        const file = Array.from(files).at(-1)!
        try {
            const isValidType = ACCEPTED_BRD_TYPES.includes(file.type) ||
                ACCEPTED_BRD_EXTS.some(ext => file.name.toLowerCase().endsWith(ext))
            if (!isValidType) {
                toast.error(`"${file.name}" is not supported. Upload PDF, Word, or Text files.`)
                setBrdUploading(false)
                return
            }
            if (file.size > 20 * 1024 * 1024) {
                toast.error(`"${file.name}" exceeds the 20 MB limit.`)
                setBrdUploading(false)
                return
            }
            const content = await readFileContent(file)
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${id}/brd`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: file.name, content }),
            })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            setBrdDocs([{
                id: 'brd-persisted',
                name: file.name,
                size: file.size,
                type: file.type || 'application/octet-stream',
                uploadedAt: new Date().toISOString(),
            }])
            toast.success(`"${file.name}" uploaded and saved to this project!`)
        } catch (err: any) {
            toast.error(`Failed to upload "${file.name}": ${err.message ?? 'Unknown error'}`)
        } finally {
            setBrdUploading(false)
        }
    }

    const handleTestCaseFileUpload = async (files: FileList | null) => {
        if (!files || files.length === 0) return
        setTestCaseUploading(true)
        const file = Array.from(files).at(-1)!
        try {
            const isValidType = ACCEPTED_TC_TYPES.includes(file.type) ||
                ACCEPTED_TC_EXTS.some(ext => file.name.toLowerCase().endsWith(ext))
            if (!isValidType) {
                toast.error(`"${file.name}" is not supported. Upload CSV, Excel, or Word files.`)
                setTestCaseUploading(false)
                return
            }
            if (file.size > 20 * 1024 * 1024) {
                toast.error(`"${file.name}" exceeds the 20 MB limit.`)
                setTestCaseUploading(false)
                return
            }
            const content = await readFileContent(file)
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${id}/existing-tests`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ filename: file.name, content }),
            })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            setTestCaseDocs([{
                id: 'tc-persisted',
                name: file.name,
                size: file.size,
                type: file.type || 'application/octet-stream',
                uploadedAt: new Date().toISOString(),
            }])
            toast.success(`"${file.name}" uploaded and saved to this project!`)
        } catch (err: any) {
            toast.error(`Failed to upload "${file.name}": ${err.message ?? 'Unknown error'}`)
        } finally {
            setTestCaseUploading(false)
        }
    }

    const removeBrdDoc = async (_docId: string) => {
        try {
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${id}/brd`, {
                method: 'DELETE',
            })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            setBrdDocs([])
            toast.info('BRD document removed from project')
        } catch (err: any) {
            toast.error(`Failed to remove document: ${err.message ?? 'Unknown error'}`)
        }
    }

    const removeTestCaseDoc = async (_docId: string) => {
        try {
            const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${id}/existing-tests`, {
                method: 'DELETE',
            })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            setTestCaseDocs([])
            toast.info('Test cases file removed from project')
        } catch (err: any) {
            toast.error(`Failed to remove file: ${err.message ?? 'Unknown error'}`)
        }
    }

    const handleDisconnect = async () => {
        if (!confirm("Are you sure you want to disconnect this integration?")) return
        setDisconnecting(true)
        try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${id}/disconnect`, { method: "DELETE" })
            if (response.ok || response.status === 204) {
                toast.success("Integration disconnected")
                setIntegration({ category: null, status: "disconnected" })
            }
        } catch { toast.error("Disconnect failed") }
        finally { setDisconnecting(false) }
    }


    const SF_INLINE_ERRORS: Record<string, string> = {
        INVALID_CLIENT: "Invalid Salesforce credentials or Connected App details. Please check and try again.",
        INVALID_CREDENTIALS: "Invalid Salesforce credentials or Connected App details. Please check and try again.",
        CONNECTION_TIMEOUT: "Could not reach Salesforce. Check your Login URL and try again.",
        INVALID_GRANT: "Invalid Salesforce credentials or Connected App details. Please check and try again.",
    }

    const handleInlineConnect = async () => {
        let hasError = false
        if (!sfIUsername.trim()) { setSfIUsernameErr("Username is required"); hasError = true }
        if (!sfIPassword.trim()) { setSfIPasswordErr("Password is required"); hasError = true }
        if (!sfIClientId.trim()) { setSfIClientIdErr("Client ID is required"); hasError = true }
        if (!sfIClientSecret.trim()) { setSfIClientSecretErr("Client Secret is required"); hasError = true }
        if (hasError) return

        setSfIConnectError(null)
        setSfISuccess(null)
        setSfIConnecting(true)
        try {
            // Step 1 — save Connected App credentials
            const saveRes = await fetch(
                `${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${id}/save-sf-credentials`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        client_id: sfIClientId,
                        client_secret: sfIClientSecret,
                        redirect_uri: sfIRedirectUri,
                        login_url: sfILoginUrl,
                        sf_username: sfIUsername,
                        sf_password: sfIPassword,
                        sf_security_token: sfISecurityToken,
                    }),
                },
            )
            if (!saveRes.ok) {
                const err = await saveRes.json().catch(() => ({}))
                setSfIConnectError(SF_INLINE_ERRORS[err.error ?? ""] ?? "Connection failed. Please check your details and try again.")
                return
            }

            // Step 2 — OAuth / JSForce registration
            const oauthRes = await fetch(
                `${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${id}/connect`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ category: "salesforce" }),
                },
            )
            if (!oauthRes.ok) {
                const err = await oauthRes.json().catch(() => ({}))
                setSfIConnectError(SF_INLINE_ERRORS[err.error ?? ""] ?? err.detail ?? "Connection failed. Please check your details and try again.")
                return
            }
            const oauthData = await oauthRes.json()
            if (oauthData.auth_url) {
                toast.info("Redirecting to Salesforce login...")
                window.location.href = oauthData.auth_url
                return
            }

            // Step 3 — MCP connection using same credentials
            let mcpOk = false
            try {
                const mcpRes = await fetch(
                    `${process.env.NEXT_PUBLIC_API_URL}/api/v1/mcp/projects/${id}/mcp-connect`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            sf_username: sfIUsername,
                            sf_password: sfIPassword,
                            sf_security_token: sfISecurityToken,
                            domain: sfILoginUrl.includes("test") ? "test" : "login",
                        }),
                    },
                )
                mcpOk = mcpRes.ok
            } catch { mcpOk = false }

            setSfISuccess({ oAuth: true, mcp: mcpOk, sync: mcpOk })
            // Refresh integration status after 2 s so the tab auto-switches to connected view
            setTimeout(() => fetchIntegration(), 2000)
        } catch {
            setSfIConnectError("Connection failed. Please check your details and try again.")
        } finally {
            setSfIConnecting(false)
        }
    }

    const handleConnect = async () => {
        const cat = project?.category || "webapp"
        if (cat === "salesforce") {
            // Redirect to the wizard's Connect step pre-loaded with this project
            router.push(`/dashboard/projects/create?connect=${id}`)
        } else {
            // Pass ?edit=<id> so the wizard loads existing data and updates in place
            router.push(`/dashboard/projects/create?edit=${id}`)
        }
    }

    // MCP Connect
    const handleMcpConnect = async () => {
        if (!mcpUsername || !mcpPassword || !mcpSecurityToken) {
            toast.error("Please fill in all credential fields")
            return
        }
        setMcpConnecting(true)
        try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/mcp/projects/${id}/mcp-connect`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    sf_username: mcpUsername,
                    sf_password: mcpPassword,
                    sf_security_token: mcpSecurityToken,
                    domain: mcpDomain,
                }),
            })
            const data = await response.json()
            if (response.ok) {
                toast.success(`Connected to Salesforce via MCP! (${data.org_name || data.instance_url})`)
                setMcpUsername("")
                setMcpPassword("")
                setMcpSecurityToken("")
                fetchIntegration()
            } else {
                toast.error(data.detail || "MCP connection failed")
            }
        } catch { toast.error("MCP connection request failed") }
        finally { setMcpConnecting(false) }
    }

    // MCP SOQL Query
    const handleQuery = async () => {
        if (!soqlQuery.trim()) return
        setQueryLoading(true)
        try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/mcp/projects/${id}/mcp/query`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ query: soqlQuery }),
            })
            const data = await response.json()
            if (response.ok) {
                setQueryResults(data)
                toast.success(`Query returned ${data.total_size} record(s)`)
            } else {
                toast.error(data.detail || "Query failed")
                setQueryResults(null)
            }
        } catch { toast.error("Query request failed") }
        finally { setQueryLoading(false) }
    }

    // MCP Create Record
    const handleCreateRecord = async () => {
        setCreateLoading(true)
        try {
            const parsedData = JSON.parse(createData)
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/mcp/projects/${id}/mcp/records/${createObjectType}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ data: parsedData }),
            })
            const data = await response.json()
            if (response.ok && data.success) {
                toast.success(`${createObjectType} created! ID: ${data.id}`)
            } else {
                toast.error(data.detail || "Create failed")
            }
        } catch (e: any) {
            toast.error(e.message?.includes("JSON") ? "Invalid JSON data" : "Create request failed")
        }
        finally { setCreateLoading(false) }
    }

    // MCP Update Record
    const handleUpdateRecord = async () => {
        if (!updateRecordId.trim()) { toast.error("Record ID is required"); return }
        setUpdateLoading(true)
        try {
            const parsedData = JSON.parse(updateData)
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/mcp/projects/${id}/mcp/records/${updateObjectType}/${updateRecordId}`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ data: parsedData }),
            })
            const data = await response.json()
            if (response.ok && data.success) {
                toast.success(`${updateObjectType} record updated!`)
            } else {
                toast.error(data.detail || "Update failed")
            }
        } catch (e: any) {
            toast.error(e.message?.includes("JSON") ? "Invalid JSON data" : "Update request failed")
        }
        finally { setUpdateLoading(false) }
    }

    // MCP Delete Record
    const handleDeleteRecord = async () => {
        if (!deleteRecordId.trim()) { toast.error("Record ID is required"); return }
        if (!confirm(`Delete ${deleteObjectType} record ${deleteRecordId}?`)) return
        setDeleteLoading(true)
        try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/mcp/projects/${id}/mcp/records/${deleteObjectType}/${deleteRecordId}`, {
                method: "DELETE",
            })
            const data = await response.json()
            if (response.ok && data.success) {
                toast.success(`${deleteObjectType} record deleted!`)
                setDeleteRecordId("")
            } else {
                toast.error(data.detail || "Delete failed")
            }
        } catch { toast.error("Delete request failed") }
        finally { setDeleteLoading(false) }
    }

    // MCP Org Limits
    const handleFetchLimits = async () => {
        setLimitsLoading(true)
        try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/mcp/projects/${id}/mcp/limits`)
            const data = await response.json()
            if (response.ok) {
                setOrgLimits(data.key_limits)
            } else {
                toast.error(data.detail || "Failed to fetch limits")
            }
        } catch { toast.error("Limits request failed") }
        finally { setLimitsLoading(false) }
    }

    if (isLoading) return (
        <div className="flex items-center justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
    )
    if (!project) return (
        <div className="flex flex-col items-center justify-center py-16">
            <h3 className="text-lg font-semibold mb-2">Environment not found</h3>
            <Button onClick={() => router.push("/dashboard/projects")}>Back to Environments</Button>
        </div>
    )

    const isConnected = integration?.status === "connected"
    const isSalesforce = integration?.category === "salesforce"
    const isMcp = integration?.mcp_connected === true
    const isApi = integration?.category === "api"
    const isWebApp = !isSalesforce && !isApi   // web_app or unset category
    const isSalesforceProject = (project?.category || "webapp") === "salesforce" || (project?.type || "").toUpperCase() === "SALESFORCE"

    const getCategoryIcon = () => {
        if (isSalesforce && isMcp) return <Zap className="h-5 w-5 text-orange-500" />
        if (isSalesforce) return <Cloud className="h-5 w-5 text-purple-600" />
        if (isApi) return <Server className="h-5 w-5 text-green-600" />
        return <Globe className="h-5 w-5 text-blue-600" />
    }
    const getCategoryLabel = () => {
        if (isSalesforce && isMcp) return "Salesforce MCP Server"
        if (isSalesforce) return "Salesforce Organization"
        if (isApi) return "API Service"
        return "Web Application"
    }

    const inputClass = "w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-background text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
    const labelClass = "block text-sm font-medium text-muted-foreground mb-1"

    return (
        <div className="space-y-6">
            {/* Breadcrumb */}
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Link href="/dashboard/projects" className="hover:text-foreground">Environments</Link>
                <span>›</span>
                <span className="text-foreground">{project.name}</span>
            </div>

            {/* Header */}
            <div className="flex items-start justify-between">
                <div className="space-y-1">
                    <div className="flex items-center gap-3">
                        <h2 className="text-3xl font-bold tracking-tight">{project.name}</h2>
                        <Badge variant="outline">{project.type}</Badge>
                        <Badge variant="secondary">{project.category || "webapp"}</Badge>
                        {isConnected && (
                            <Badge
                                variant="outline"
                                style={{ backgroundColor: '#D6E5BD', color: '#15803d', borderColor: '#c2d1a7' }}
                                className="hover:opacity-90"
                            >
                                <Check className="h-3 w-3 mr-1" /> Connected
                            </Badge>
                        )}
                        {isConnected && isMcp && (
                            <Badge
                                variant="outline"
                                style={{ backgroundColor: '#FFE5E7', color: '#b91c1c', borderColor: '#fecaca' }}
                                className="hover:opacity-90"
                            >
                                <Zap className="h-3 w-3 mr-1" /> MCP
                            </Badge>
                        )}
                    </div>
                    <p className="text-muted-foreground">{project.description || "No description provided"}</p>
                </div>
                <Button variant="outline" onClick={() => router.push("/dashboard/projects")}>
                    <ArrowLeft className="mr-2 h-4 w-4" /> Back
                </Button>
            </div>

            {/* Tabs */}
            <Tabs defaultValue="overview" className="space-y-4">
                <TabsList>
                    <TabsTrigger value="overview"><BarChart3 className="mr-2 h-4 w-4" /> Overview</TabsTrigger>
                    <TabsTrigger value="integration"><Link2 className="mr-2 h-4 w-4" /> Integration</TabsTrigger>
                    <TabsTrigger value="artifacts"><FolderOpen className="mr-2 h-4 w-4" /> Artifacts</TabsTrigger>
                    {isConnected && isMcp && (
                        <TabsTrigger value="mcp-ops"><Database className="mr-2 h-4 w-4" /> MCP Operations</TabsTrigger>
                    )}
                    <TabsTrigger value="settings"><Settings className="mr-2 h-4 w-4" /> Jira Integration</TabsTrigger>
                    <TabsTrigger value="generate" className="bg-gradient-to-r from-violet-50 to-purple-50 dark:from-violet-950/30 dark:to-purple-950/30 data-[state=active]:from-violet-100 data-[state=active]:to-purple-100">
                        <Sparkles className="mr-2 h-4 w-4 text-violet-500" /> Generate Test Cases
                    </TabsTrigger>
                </TabsList>

                {/* Overview Tab */}
                <TabsContent value="overview" className="space-y-4">
                    <div className="grid gap-4 md:grid-cols-3">
                        <Card>
                            <CardHeader className="pb-3"><CardTitle className="text-sm font-medium">Total Test Cases</CardTitle></CardHeader>
                            <CardContent><div className="text-2xl font-bold">0</div><p className="text-xs text-muted-foreground">No tests created yet</p></CardContent>
                        </Card>
                        <Card>
                            <CardHeader className="pb-3"><CardTitle className="text-sm font-medium">Last Execution</CardTitle></CardHeader>
                            <CardContent><div className="text-2xl font-bold">-</div><p className="text-xs text-muted-foreground">Never executed</p></CardContent>
                        </Card>
                        <Card>
                            <CardHeader className="pb-3"><CardTitle className="text-sm font-medium">Pass Rate</CardTitle></CardHeader>
                            <CardContent><div className="text-2xl font-bold">-</div><p className="text-xs text-muted-foreground">No data available</p></CardContent>
                        </Card>
                    </div>
                    <Card>
                        <CardHeader><CardTitle>Environment Information</CardTitle></CardHeader>
                        <CardContent>
                            <div className="grid grid-cols-2 gap-4">
                                {[
                                    ["Type", project.type],
                                    ["Category", project.category || "webapp"],
                                    ["Status", project.status],
                                    ["Base URL", project.base_url || "Not set"],
                                    ["Created", new Date(project.created_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })],
                                ].map(([label, value]) => (
                                    <div key={label}>
                                        <p className="text-sm font-medium text-muted-foreground">{label}</p>
                                        <p className="text-sm">{value}</p>
                                    </div>
                                ))}
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>

                {/* Integration Tab */}
                <TabsContent value="integration" className="space-y-4">
                    {integrationLoading ? (
                        <div className="flex justify-center py-8"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
                    ) : isConnected ? (
                        <>
                            {/* Connection Info Card */}
                            <Card className="border-green-200 dark:border-green-900">
                                <CardHeader>
                                    <div className="flex items-center justify-between">
                                        <div className="flex items-center gap-2">
                                            {getCategoryIcon()}
                                            <CardTitle>{getCategoryLabel()}</CardTitle>
                                            <Badge variant="outline" style={{ backgroundColor: '#D6E5BD', color: '#15803d', borderColor: '#c2d1a7' }} className="hover:opacity-90">Connected</Badge>
                                            {isMcp && <Badge variant="outline" style={{ backgroundColor: '#FFE5E7', color: '#b91c1c', borderColor: '#fecaca' }} className="hover:opacity-90">MCP Server</Badge>}
                                        </div>
                                        <div className="flex gap-2">
                                            {(isSalesforce || isApi || isWebApp) && (
                                                <Button variant="outline" size="sm" onClick={handleSyncMetadata} disabled={syncing}>
                                                    {syncing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                                                    {isWebApp ? "Sync Metadata" : "Resync Metadata"}
                                                </Button>
                                            )}
                                            <Button variant="destructive" size="sm" onClick={handleDisconnect} disabled={disconnecting}>
                                                <Unplug className="mr-2 h-4 w-4" /> Disconnect
                                            </Button>
                                        </div>
                                    </div>
                                </CardHeader>
                                <CardContent>
                                    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                                        {integration?.instance_url && (
                                            <div>
                                                <p className="text-sm font-medium text-muted-foreground">Instance URL</p>
                                                <p className="text-sm truncate">{integration.instance_url}</p>
                                            </div>
                                        )}
                                        {integration?.base_url && (
                                            <div>
                                                <p className="text-sm font-medium text-muted-foreground">Base URL</p>
                                                <p className="text-sm truncate">{integration.base_url}</p>
                                            </div>
                                        )}
                                        {integration?.org_id && (
                                            <div>
                                                <p className="text-sm font-medium text-muted-foreground">Salesforce Org ID</p>
                                                <p className="text-sm font-mono">{integration.org_id}</p>
                                            </div>
                                        )}
                                        {isMcp && (
                                            <div>
                                                <p className="text-sm font-medium text-muted-foreground">Connection Type</p>
                                                <p className="text-sm flex items-center gap-1">
                                                    <Zap className="h-3 w-3 text-orange-500" /> MCP Server (Direct API)
                                                </p>
                                            </div>
                                        )}
                                        {integration?.salesforce_login_url && isSalesforce && !isMcp && (
                                            <div>
                                                <p className="text-sm font-medium text-muted-foreground">Login URL</p>
                                                <p className="text-sm truncate">{integration.salesforce_login_url}</p>
                                            </div>
                                        )}
                                        {integration?.login_strategy && (
                                            <div>
                                                <p className="text-sm font-medium text-muted-foreground">Login Strategy</p>
                                                <p className="text-sm capitalize">{integration.login_strategy}</p>
                                            </div>
                                        )}
                                        {isSalesforce && !isMcp && (
                                            <div>
                                                <p className="text-sm font-medium text-muted-foreground">Connected App</p>
                                                <p className="text-sm">
                                                    {integration?.has_sf_credentials ? (
                                                        <span className="text-green-600 flex items-center gap-1"><Check className="h-3 w-3" /> Per-environment credentials</span>
                                                    ) : (
                                                        <span className="text-amber-600">Using global env vars</span>
                                                    )}
                                                </p>
                                            </div>
                                        )}
                                        <div>
                                            <p className="text-sm font-medium text-muted-foreground">Last Synced</p>
                                            <p className="text-sm">{integration?.last_synced_at ? new Date(integration.last_synced_at).toLocaleString() : "Never"}</p>
                                        </div>
                                    </div>
                                    {integration?.sync_error && (
                                        <div className="mt-4 p-3 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 rounded-md">
                                            <div className="flex items-center gap-2 text-red-700 dark:text-red-400 text-sm">
                                                <AlertCircle className="h-4 w-4" />
                                                <span className="font-medium">Sync Error:</span> {integration.sync_error}
                                            </div>
                                        </div>
                                    )}
                                </CardContent>
                            </Card>

                            {/* Metadata Counts */}
                            {integration?.sync_counts && (
                                <div className="grid gap-4 md:grid-cols-4">
                                    {[
                                        { 
                                            label: "Pages Crawled", 
                                            count: integration.sync_counts.pages_crawled ?? integration.sync_counts.raw_count, 
                                            color: "text-blue-600" 
                                        },
                                        { label: "Normalized", count: integration.sync_counts.normalized_count, color: "text-indigo-600" },
                                        { label: "Domain Models", count: integration.sync_counts.domain_model_count, color: "text-purple-600" },
                                        { label: "Embeddings", count: integration.sync_counts.embedding_count, color: "text-green-600" },
                                    ].map((item) => (
                                        <Card key={item.label}>
                                            <CardContent className="pt-6">
                                                <div className={`text-2xl font-bold ${item.color}`}>{item.count}</div>
                                                <p className="text-xs text-muted-foreground mt-1">{item.label}</p>
                                            </CardContent>
                                        </Card>
                                    ))}
                                </div>
                            )}

                            {/* Web App Crawler Status Card */}
                            {isWebApp && isConnected && (
                                <>
                                {/* Sync Progress Card — shown while syncing */}
                                {syncing && syncProgress && (
                                    <Card className="border-blue-300 dark:border-blue-700 bg-gradient-to-br from-blue-50/80 to-indigo-50/60 dark:from-blue-950/30 dark:to-indigo-950/20 overflow-hidden">
                                        <CardHeader className="pb-3">
                                            <div className="flex items-center gap-3">
                                                <div className="relative">
                                                    <Globe className="h-5 w-5 text-blue-600" />
                                                    <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-blue-500 rounded-full animate-ping" />
                                                </div>
                                                <CardTitle className="text-base text-blue-900 dark:text-blue-100">Syncing Metadata…</CardTitle>
                                                <Badge className="bg-blue-100 text-blue-700 border-blue-200 animate-pulse">In Progress</Badge>
                                            </div>
                                            <CardDescription className="text-blue-700 dark:text-blue-300">
                                                {crawlProgress?.progressMessage
                                                    ? crawlProgress.progressMessage
                                                    : "Running the 4-stage Playwright pipeline. This may take 1–3 minutes."}
                                            </CardDescription>
                                        </CardHeader>
                                        <CardContent className="space-y-4">

                                            {/* Incremental crawl progress bar — only shown when paginating */}
                                            {crawlProgress && crawlProgress.totalDiscovered > 0 && (
                                                <div className="rounded-xl bg-white/70 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 p-4 space-y-2">
                                                    <div className="flex items-center justify-between mb-1">
                                                        <span className="text-xs font-semibold text-blue-800 dark:text-blue-200 flex items-center gap-1.5">
                                                            <Search className="h-3.5 w-3.5" />
                                                            Deep UI Discovery
                                                        </span>
                                                        <span className="text-xs font-bold text-blue-700 dark:text-blue-300">
                                                            {crawlProgress.crawledSoFar} / {crawlProgress.totalDiscovered} pages
                                                        </span>
                                                    </div>
                                                    {/* Determinate progress bar */}
                                                    <div className="w-full h-2.5 bg-blue-100 dark:bg-blue-900/50 rounded-full overflow-hidden">
                                                        <div
                                                            className="h-full bg-gradient-to-r from-blue-500 to-indigo-500 rounded-full transition-all duration-700 ease-out"
                                                            style={{ width: `${Math.min(100, Math.round((crawlProgress.crawledSoFar / Math.max(1, crawlProgress.totalDiscovered)) * 100))}%` }}
                                                        />
                                                    </div>
                                                    <div className="flex items-center justify-between">
                                                        <span className="text-xs text-blue-600 dark:text-blue-400">
                                                            {crawlProgress.hasMorePages
                                                                ? <span className="flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Continuing automatically…</span>
                                                                : <span className="flex items-center gap-1 text-green-600"><Check className="h-3 w-3" /> Crawl complete</span>
                                                            }
                                                        </span>
                                                        <span className="text-xs text-blue-500">
                                                            {Math.min(100, Math.round((crawlProgress.crawledSoFar / Math.max(1, crawlProgress.totalDiscovered)) * 100))}%
                                                        </span>
                                                    </div>
                                                </div>
                                            )}

                                            {/* Pipeline stage steps */}
                                            {[
                                                { stage: 1, label: "Playwright Crawl", desc: "Discovering pages & extracting DOM", color: "blue", count: syncProgress.raw_count, unit: "pages" },
                                                { stage: 2, label: "Normalization", desc: "Structuring raw metadata to JSON", color: "indigo", count: syncProgress.normalized_count, unit: "records" },
                                                { stage: 3, label: "Domain Models", desc: "Building testing rules & actions", color: "purple", count: syncProgress.domain_model_count, unit: "models" },
                                                { stage: 4, label: "Embeddings", desc: "Generating vectors for RAG", color: "emerald", count: syncProgress.embedding_count, unit: "vectors" },
                                            ].map((s) => {
                                                const isActive = syncProgress.active_stage === s.stage ||
                                                    // Stage 1 stays active during all incremental crawl runs
                                                    (s.stage === 1 && crawlProgress?.hasMorePages)
                                                const isDone = s.count > 0 && (syncProgress.active_stage === null || syncProgress.active_stage > s.stage)
                                                return (
                                                    <div key={s.stage} className={`flex items-center gap-3 rounded-lg px-4 py-3 transition-all duration-500 ${
                                                        isActive ? `bg-${s.color}-100/80 dark:bg-${s.color}-900/30 border border-${s.color}-200 dark:border-${s.color}-800 shadow-sm` :
                                                        isDone ? 'bg-white/60 dark:bg-white/5 border border-green-200 dark:border-green-900' :
                                                        'bg-white/30 dark:bg-white/5 border border-gray-100 dark:border-gray-800 opacity-60'
                                                    }`}>
                                                        <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${
                                                            isDone ? 'bg-green-100 text-green-700' :
                                                            isActive ? 'bg-blue-500 text-white' :
                                                            'bg-gray-100 text-gray-400'
                                                        }`}>
                                                            {isDone ? <Check className="h-4 w-4" /> : isActive ? <Loader2 className="h-4 w-4 animate-spin" /> : s.stage}
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                            <div className="flex items-center gap-2">
                                                                <span className={`text-sm font-semibold ${isActive ? 'text-blue-900 dark:text-blue-100' : isDone ? 'text-green-700 dark:text-green-400' : 'text-gray-400'}`}>
                                                                    {s.label}
                                                                </span>
                                                                {isActive && <span className="text-xs text-blue-600 animate-pulse font-medium">Running…</span>}
                                                                {isDone && <span className="text-xs text-green-600 font-medium">{s.count} {s.unit}</span>}
                                                            </div>
                                                            <p className="text-xs text-muted-foreground truncate">
                                                                {s.stage === 1 && crawlProgress?.hasMorePages
                                                                    ? `${crawlProgress.crawledSoFar} of ${crawlProgress.totalDiscovered} pages discovered so far`
                                                                    : s.desc}
                                                            </p>
                                                        </div>
                                                        {isActive && (
                                                            <div className="flex-shrink-0">
                                                                <div className="w-16 h-1.5 bg-blue-100 rounded-full overflow-hidden relative">
                                                                    <div className="absolute inset-y-0 w-8 bg-blue-500 rounded-full" style={{ animation: 'progress 1.8s ease-in-out infinite' }} />
                                                                </div>
                                                            </div>
                                                        )}
                                                    </div>
                                                )
                                            })}
                                        </CardContent>
                                    </Card>
                                )}

                                {/* Sync Completed Banner */}
                                {syncCompleted && (
                                    <Card className="border-green-300 dark:border-green-700 bg-gradient-to-br from-green-50 to-emerald-50/60 dark:from-green-950/30 dark:to-emerald-950/20">
                                        <CardContent className="pt-5 pb-4">
                                            <div className="flex items-start gap-3">
                                                <div className="flex-shrink-0 w-9 h-9 rounded-full bg-green-100 flex items-center justify-center">
                                                    <Check className="h-5 w-5 text-green-600" />
                                                </div>
                                                <div className="flex-1">
                                                    <p className="text-sm font-semibold text-green-800 dark:text-green-200 mb-1">Metadata Sync Completed ✅</p>
                                                    <p className="text-xs text-green-700 dark:text-green-400 mb-3">
                                                        Completed at {new Date(syncCompleted.completed_at).toLocaleTimeString()}
                                                    </p>
                                                    <div className="grid grid-cols-4 gap-2">
                                                        {[
                                                            { label: "Pages Crawled", count: syncCompleted.pages_crawled, color: "text-blue-700" },
                                                            { label: "Normalized", count: syncCompleted.normalized_count, color: "text-indigo-700" },
                                                            { label: "Domain Models", count: syncCompleted.domain_model_count, color: "text-purple-700" },
                                                            { label: "Embeddings", count: syncCompleted.embedding_count, color: "text-emerald-700" },
                                                        ].map(item => (
                                                            <div key={item.label} className="text-center bg-white/70 dark:bg-white/10 rounded-lg py-2 px-1">
                                                                <div className={`text-xl font-bold ${item.color}`}>{item.count}</div>
                                                                <div className="text-xs text-muted-foreground leading-tight">{item.label}</div>
                                                            </div>
                                                        ))}
                                                    </div>
                                                </div>
                                                <button onClick={() => setSyncCompleted(null)} className="text-muted-foreground hover:text-foreground flex-shrink-0">
                                                    <X className="h-4 w-4" />
                                                </button>
                                            </div>
                                        </CardContent>
                                    </Card>
                                )}

                                <Card className="border-blue-200 dark:border-blue-900">
                                    <CardHeader>
                                        <div className="flex items-center gap-2">
                                            <Globe className="h-5 w-5 text-blue-600" />
                                            <CardTitle className="text-lg">Web App Crawler</CardTitle>
                                        </div>
                                        <CardDescription>
                                            The Hybrid Metadata Extractor uses sitemap discovery combined with a Playwright crawler to extract exact live DOM metadata — buttons, forms, inputs, and navigation — for AI-powered test generation.
                                        </CardDescription>
                                    </CardHeader>
                                    <CardContent>
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                            <div className="space-y-3">
                                                <div>
                                                    <p className="text-sm font-medium text-muted-foreground">Crawl Target Base URL</p>
                                                    <p className="text-sm font-mono truncate mt-1">{integration?.base_url || project.base_url || "—"}</p>
                                                </div>
                                                <div>
                                                    <p className="text-sm font-medium text-muted-foreground">Sitemap Target</p>
                                                    <p className="text-sm font-mono truncate mt-1">{(integration?.auth_config as any)?.sitemap_url || "Auto-discover (sitemap.xml)"}</p>
                                                </div>
                                                <div>
                                                    <p className="text-sm font-medium text-muted-foreground">Max Pages Configured</p>
                                                    <p className="text-sm mt-1">{(integration?.auth_config as any)?.max_crawl_pages || 30} pages</p>
                                                </div>
                                                <div>
                                                    <p className="text-sm font-medium text-muted-foreground">Last Sync</p>
                                                    <p className="text-sm mt-1 flex items-center gap-1">
                                                        <Clock className="h-3 w-3 text-muted-foreground" />
                                                        {integration?.last_synced_at ? new Date(integration.last_synced_at).toLocaleString() : "Never — click Sync Metadata to start"}
                                                    </p>
                                                </div>
                                            </div>
                                            <div>
                                                <p className="text-sm font-medium text-muted-foreground mb-2">4-Stage Pipeline</p>
                                                <div className="space-y-2">
                                                    {[
                                                        { stage: "1", label: "Playwright crawl", desc: "DOM extraction", color: "bg-blue-100 text-blue-700" },
                                                        { stage: "2", label: "Normalization", desc: "Structured JSON", color: "bg-indigo-100 text-indigo-700" },
                                                        { stage: "3", label: "Domain Models", desc: "Test rules", color: "bg-purple-100 text-purple-700" },
                                                        { stage: "4", label: "Embeddings", desc: "RAG / Vector DB", color: "bg-green-100 text-green-700" },
                                                    ].map((s) => (
                                                        <div key={s.stage} className="flex items-center gap-2">
                                                            <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-xs font-bold ${s.color}`}>{s.stage}</span>
                                                            <span className="text-sm font-medium">{s.label}</span>
                                                            <span className="text-xs text-muted-foreground">— {s.desc}</span>
                                                        </div>
                                                    ))}
                                                </div>
                                            </div>
                                        </div>
                                        {!integration?.last_synced_at && (
                                            <div className="mt-4 p-3 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-md">
                                                <p className="text-sm text-blue-700 dark:text-blue-300">
                                                    <strong>No metadata yet.</strong> Click <strong>Sync Metadata</strong> above to start your first Playwright crawl. The process runs in the background and typically completes in under 2 minutes.
                                                </p>
                                            </div>
                                        )}
                                    </CardContent>
                                </Card>
                                </>
                            )}

                            {/* Web App Session & Login Card */}
                            {isWebApp && isConnected && (
                                <Card className="border-blue-200 dark:border-blue-900">
                                    <CardHeader>
                                        <div className="flex items-center gap-2">
                                            <Key className="h-5 w-5 text-blue-600" />
                                            <CardTitle className="text-lg">Session &amp; Login</CardTitle>
                                        </div>
                                        <CardDescription>
                                            AutoTest AI logs in before each test run using these credentials. The session is stored so the browser starts authenticated.
                                        </CardDescription>
                                    </CardHeader>
                                    <CardContent className="space-y-5">
                                        {/* Session Status Row */}
                                        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                                            <div>
                                                <p className="text-sm font-medium text-muted-foreground">UI Session</p>
                                                <p className="text-sm mt-1">
                                                    {integration?.ui_session?.status === "active" ? (
                                                        <Badge className="bg-green-100 text-green-700 border-green-200">🟢 Active</Badge>
                                                    ) : integration?.ui_session?.status === "expired" ? (
                                                        <Badge className="bg-yellow-100 text-yellow-700 border-yellow-200">🟡 Expired</Badge>
                                                    ) : (
                                                        <Badge variant="outline" className="text-muted-foreground">⚪ Not Created</Badge>
                                                    )}
                                                </p>
                                            </div>
                                            <div>
                                                <p className="text-sm font-medium text-muted-foreground">Login Strategy</p>
                                                <p className="text-sm capitalize mt-1">{integration?.login_strategy || "form"}</p>
                                            </div>
                                            <div>
                                                <p className="text-sm font-medium text-muted-foreground">Last Session Refresh</p>
                                                <p className="text-sm mt-1 flex items-center gap-1">
                                                    <Clock className="h-3 w-3 text-muted-foreground" />
                                                    {integration?.ui_session?.last_created_at
                                                        ? new Date(integration.ui_session.last_created_at).toLocaleString()
                                                        : "Never"}
                                                </p>
                                            </div>
                                        </div>

                                        <div className="h-px bg-border" />

                                        {/* Credentials Form */}
                                        <div className="grid gap-4 max-w-lg">
                                            <p className="text-xs text-muted-foreground">
                                                Fields are pre-filled from your project setup. Enter a new password only if you want to update it — leaving the password blank keeps the existing one.
                                            </p>

                                            {/* Login URL */}
                                            <div>
                                                <label className={labelClass}>Login URL</label>
                                                <input
                                                    type="url"
                                                    placeholder={`${project?.base_url || "https://yourapp.com"}/login`}
                                                    value={webLoginUrl}
                                                    onChange={(e) => setWebLoginUrl(e.target.value)}
                                                    className={inputClass}
                                                    autoComplete="off"
                                                />
                                                <p className="text-xs text-muted-foreground mt-1">
                                                    The exact URL of the login page (e.g. <code className="font-mono">/login</code>). Defaults to the base URL if blank.
                                                </p>
                                            </div>

                                            {/* Username / Email */}
                                            <div>
                                                <label className={labelClass}>Username / Email</label>
                                                <input
                                                    type="text"
                                                    placeholder="e.g. admin@yourapp.com"
                                                    value={webUsername}
                                                    onChange={(e) => setWebUsername(e.target.value)}
                                                    className={inputClass}
                                                    autoComplete="off"
                                                />
                                            </div>

                                            {/* Password */}
                                            <div>
                                                <label className={labelClass}>Password</label>
                                                <div className="relative">
                                                    <input
                                                        type={webShowPassword ? "text" : "password"}
                                                        placeholder="Enter password"
                                                        value={webPassword}
                                                        onChange={(e) => setWebPassword(e.target.value)}
                                                        className={inputClass + " pr-10"}
                                                        autoComplete="new-password"
                                                    />
                                                    <button
                                                        type="button"
                                                        onClick={() => setWebShowPassword(!webShowPassword)}
                                                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                                    >
                                                        {webShowPassword ? "🙈" : "👁"}
                                                    </button>
                                                </div>
                                            </div>

                                            {/* Login Strategy */}
                                            <div>
                                                <label className={labelClass}>Login Strategy</label>
                                                <select
                                                    value={webLoginStrategy}
                                                    onChange={(e) => setWebLoginStrategy(e.target.value)}
                                                    className={inputClass}
                                                >
                                                    <option value="form">Form-based (fill username + password fields)</option>
                                                    <option value="basic_auth">Basic Auth (HTTP header authentication)</option>
                                                    <option value="keycloak">🔐 Keycloak / OAuth Custom Token (sessionStorage injection)</option>
                                                    <option value="none">None (skip login — app is public)</option>
                                                </select>
                                                {webLoginStrategy === "keycloak" && (
                                                    <p className="text-xs text-purple-600 dark:text-purple-400 mt-1">
                                                        🔑 Keycloak mode selected. Save credentials above first, then use the <strong>Keycloak Token Injection</strong> section below to register your session tokens.
                                                    </p>
                                                )}
                                            </div>

                                            <Button
                                                onClick={handleSaveWebCredentials}
                                                disabled={webCredSaving}
                                                className="w-full h-10 text-sm font-semibold bg-blue-600 hover:bg-blue-700"
                                            >
                                                {webCredSaving ? (
                                                    <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving…</>
                                                ) : webCredSuccess ? (
                                                    <><Check className="mr-2 h-4 w-4" />Saved!</>
                                                ) : (
                                                    <><Key className="mr-2 h-4 w-4" />Save Login Credentials</>
                                                )}
                                            </Button>

                                            {!integration?.ui_session?.last_created_at && (
                                                (integration?.web_credentials?.username || integration?.login_strategy === "none" || integration?.login_strategy === "keycloak") ? (
                                                    <div className="p-3 bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 rounded-md">
                                                        <p className="text-xs text-blue-700 dark:text-blue-300">
                                                            <strong>Ready for testing.</strong> AutoTest AI will automatically initialize the session before your next test run.
                                                        </p>
                                                    </div>
                                                ) : (
                                                    <div className="p-3 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-md">
                                                        <p className="text-xs text-amber-700 dark:text-amber-300">
                                                            <strong>No session stored yet.</strong> Save credentials above. AutoTest AI will automatically log in and store the session before your next test run.
                                                        </p>
                                                    </div>
                                                )
                                            )}
                                        </div>
                                    </CardContent>
                                </Card>
                            )}

                            {/* ─── Keycloak Token Injection Card ──────────────────────────── */}
                            {/* Shown when login_strategy is 'keycloak' for connected web app projects */}
                            {isWebApp && isConnected && (integration?.login_strategy === "keycloak" || webLoginStrategy === "keycloak") && (
                                <Card className="border-purple-200 dark:border-purple-900 bg-gradient-to-br from-purple-50/60 to-indigo-50/40 dark:from-purple-950/20 dark:to-indigo-950/10">
                                    <CardHeader>
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-2">
                                                <div className="p-1.5 rounded-lg bg-purple-600 text-white">
                                                    <Key className="h-4 w-4" />
                                                </div>
                                                <div>
                                                    <CardTitle className="text-base">🔐 Keycloak Token Injection</CardTitle>
                                                    <p className="text-xs text-muted-foreground mt-0.5">Inject HMAC-signed session tokens for Keycloak-protected apps</p>
                                                </div>
                                            </div>
                                            {/* Token Status Badge */}
                                            {kcSessionStatus?.configured && (
                                                <Badge className={`text-xs ${
                                                    kcSessionStatus.status === "valid"
                                                        ? "bg-green-100 text-green-700 border-green-200"
                                                        : kcSessionStatus.status === "expiring_soon"
                                                        ? "bg-yellow-100 text-yellow-700 border-yellow-200"
                                                        : "bg-red-100 text-red-700 border-red-200"
                                                }`}>
                                                    {kcSessionStatus.status === "valid" ? "🟢 Token Valid" :
                                                     kcSessionStatus.status === "expiring_soon" ? "🟡 Expiring Soon" : "🔴 Token Expired"}
                                                </Badge>
                                            )}
                                        </div>
                                    </CardHeader>
                                    <CardContent className="space-y-4">

                                        {/* Existing session info */}
                                        {kcSessionStatus?.configured && (
                                            <div className="rounded-lg border border-purple-200 dark:border-purple-800 bg-purple-50/50 dark:bg-purple-950/20 p-3 space-y-2">
                                                <p className="text-xs font-semibold text-purple-800 dark:text-purple-300">Current Session</p>
                                                <div className="grid grid-cols-2 gap-2 text-xs">
                                                    <div>
                                                        <span className="text-muted-foreground">Status: </span>
                                                        <span className={`font-medium ${
                                                            kcSessionStatus.is_expired ? "text-red-600" :
                                                            kcSessionStatus.is_near_expiry ? "text-yellow-600" : "text-green-600"
                                                        }`}>
                                                            {kcSessionStatus.is_expired ? "Expired" :
                                                             kcSessionStatus.is_near_expiry ? "Expiring soon" : "Valid"}
                                                        </span>
                                                    </div>
                                                    <div>
                                                        <span className="text-muted-foreground">ID Token: </span>
                                                        <span className="font-medium">{kcSessionStatus.has_id_token ? "✅ Present" : "⚠️ Missing"}</span>
                                                    </div>
                                                    {kcSessionStatus.expires_at_iso && (
                                                        <div className="col-span-2">
                                                            <span className="text-muted-foreground">Expires: </span>
                                                            <span className="font-medium">{new Date(kcSessionStatus.expires_at_iso).toLocaleString()}</span>
                                                        </div>
                                                    )}
                                                    {kcSessionStatus.refresh_url && (
                                                        <div className="col-span-2">
                                                            <span className="text-muted-foreground">Refresh URL: </span>
                                                            <code className="text-purple-700 dark:text-purple-300 font-mono">{kcSessionStatus.refresh_url}</code>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        )}

                                        {/* Info box */}
                                        <div className="rounded-lg bg-purple-50 dark:bg-purple-950/30 border border-purple-200 dark:border-purple-800 p-3">
                                            <p className="text-xs text-purple-700 dark:text-purple-300 leading-relaxed">
                                                <strong>How it works:</strong> After logging into your Keycloak-protected app in your browser,
                                                copy the <code className="font-mono bg-purple-100 dark:bg-purple-900 px-1 rounded">auth_token</code> and{" "}
                                                <code className="font-mono bg-purple-100 dark:bg-purple-900 px-1 rounded">id_token</code> from{" "}
                                                <code className="font-mono bg-purple-100 dark:bg-purple-900 px-1 rounded">sessionStorage</code>{" "}
                                                and paste them below. AutoTest AI will inject them into every test browser session via{" "}
                                                <code className="font-mono bg-purple-100 dark:bg-purple-900 px-1 rounded">sessionStorage</code> before executing steps.
                                            </p>
                                        </div>

                                        <div className="grid gap-3 max-w-lg">
                                            {/* auth_token */}
                                            <div>
                                                <label className={labelClass}>
                                                    auth_token <span className="text-red-500">*</span>
                                                    <span className="ml-1 font-normal text-muted-foreground">(Authorization: Bearer token)</span>
                                                </label>
                                                <div className="relative">
                                                    <input
                                                        id="kc-auth-token-input"
                                                        type={kcShowAuthToken ? "text" : "password"}
                                                        placeholder="Paste your auth_token here"
                                                        value={kcAuthToken}
                                                        onChange={(e) => setKcAuthToken(e.target.value)}
                                                        className={inputClass + " pr-10 font-mono text-xs"}
                                                        autoComplete="off"
                                                    />
                                                    <button
                                                        type="button"
                                                        onClick={() => setKcShowAuthToken(!kcShowAuthToken)}
                                                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                                    >
                                                        {kcShowAuthToken ? "🙈" : "👁"}
                                                    </button>
                                                </div>
                                                <p className="text-xs text-muted-foreground mt-1">
                                                    Find this in browser DevTools → Application → Session Storage → <code className="font-mono">auth_token</code>
                                                </p>
                                            </div>

                                            {/* id_token */}
                                            <div>
                                                <label className={labelClass}>
                                                    id_token
                                                    <span className="ml-1 font-normal text-muted-foreground">(Keycloak ID token — optional, for logout/refresh)</span>
                                                </label>
                                                <div className="relative">
                                                    <input
                                                        id="kc-id-token-input"
                                                        type={kcShowIdToken ? "text" : "password"}
                                                        placeholder="Paste your id_token here"
                                                        value={kcIdToken}
                                                        onChange={(e) => setKcIdToken(e.target.value)}
                                                        className={inputClass + " pr-10 font-mono text-xs"}
                                                        autoComplete="off"
                                                    />
                                                    <button
                                                        type="button"
                                                        onClick={() => setKcShowIdToken(!kcShowIdToken)}
                                                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                                    >
                                                        {kcShowIdToken ? "🙈" : "👁"}
                                                    </button>
                                                </div>
                                                <p className="text-xs text-muted-foreground mt-1">
                                                    Find this in browser DevTools → Application → Session Storage → <code className="font-mono">id_token</code>
                                                </p>
                                            </div>

                                            {/* Refresh URL */}
                                            <div>
                                                <label className={labelClass}>
                                                    Token Refresh URL
                                                    <span className="ml-1 font-normal text-muted-foreground">(optional — auto-refresh near-expiry tokens)</span>
                                                </label>
                                                <input
                                                    id="kc-refresh-url-input"
                                                    type="url"
                                                    placeholder="e.g. https://yourapp.com/api/auth/refresh"
                                                    value={kcRefreshUrl}
                                                    onChange={(e) => setKcRefreshUrl(e.target.value)}
                                                    className={inputClass}
                                                    autoComplete="off"
                                                />
                                                <p className="text-xs text-muted-foreground mt-1">
                                                    If provided, AutoTest AI will POST to this endpoint to refresh expired tokens before test runs.
                                                </p>
                                            </div>

                                            {/* Action buttons */}
                                            <div className="flex gap-2">
                                                <Button
                                                    id="kc-save-tokens-btn"
                                                    onClick={handleSaveKeycloakTokens}
                                                    disabled={kcSaving || !kcAuthToken.trim()}
                                                    className="flex-1 h-10 text-sm font-semibold bg-purple-600 hover:bg-purple-700"
                                                >
                                                    {kcSaving ? (
                                                        <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving…</>
                                                    ) : kcSuccess ? (
                                                        <><Check className="mr-2 h-4 w-4" />Saved!</>
                                                    ) : (
                                                        <><Key className="mr-2 h-4 w-4" />Save Keycloak Tokens</>
                                                    )}
                                                </Button>
                                                {kcSessionStatus?.configured && (
                                                    <Button
                                                        id="kc-clear-session-btn"
                                                        variant="outline"
                                                        onClick={handleClearKeycloakSession}
                                                        className="h-10 text-sm border-red-200 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/20"
                                                    >
                                                        <X className="mr-1 h-4 w-4" />Clear
                                                    </Button>
                                                )}
                                            </div>

                                            {/* Ready banner */}
                                            {kcSessionStatus?.configured && !kcSessionStatus.is_expired && (
                                                <div className="p-3 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 rounded-md">
                                                    <p className="text-xs text-green-700 dark:text-green-300">
                                                        <strong>✅ Keycloak session is active.</strong>{" "}
                                                        AutoTest AI will inject <code className="font-mono">auth_token</code> and{" "}
                                                        <code className="font-mono">id_token</code> into the test browser via{" "}
                                                        <code className="font-mono">sessionStorage</code> before every test run.
                                                    </p>
                                                </div>
                                            )}
                                            {kcSessionStatus?.configured && kcSessionStatus.is_expired && (
                                                <div className="p-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-md">
                                                    <p className="text-xs text-red-700 dark:text-red-300">
                                                        <strong>🔴 Token expired.</strong> Paste fresh tokens above and save to restore the session.
                                                    </p>
                                                </div>
                                            )}
                                        </div>
                                    </CardContent>
                                </Card>
                            )}

                            {isSalesforce && !isMcp && (
                                <Card>
                                    <CardHeader>
                                        <div className="flex items-center gap-2">
                                            <Key className="h-5 w-5 text-amber-600" />
                                            <CardTitle className="text-lg">Session Status</CardTitle>
                                        </div>
                                    </CardHeader>
                                    <CardContent>
                                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                            <div>
                                                <p className="text-sm font-medium text-muted-foreground">OAuth Status</p>
                                                <p className="text-sm mt-1">
                                                    {isConnected ? (
                                                        <Badge
                                                            variant="outline"
                                                            style={{ backgroundColor: '#D6E5BD', color: '#15803d', borderColor: '#c2d1a7' }}
                                                            className="hover:opacity-90"
                                                        >
                                                            <Check className="h-3 w-3 mr-1" /> Connected
                                                        </Badge>
                                                    ) : (
                                                        <Badge variant="outline" className="text-muted-foreground">
                                                            <X className="h-3 w-3 mr-1" /> Not Connected
                                                        </Badge>
                                                    )}
                                                </p>
                                            </div>
                                            <div>
                                                <p className="text-sm font-medium text-muted-foreground">UI Session</p>
                                                <p className="text-sm mt-1">
                                                    {integration?.ui_session?.status === "active" ? (
                                                        <Badge className="bg-green-100 text-green-700 border-green-200">🟢 Active</Badge>
                                                    ) : integration?.ui_session?.status === "expired" ? (
                                                        <Badge className="bg-yellow-100 text-yellow-700 border-yellow-200">🟡 Expired</Badge>
                                                    ) : (
                                                        <Badge variant="outline" className="text-muted-foreground">⚪ Not Created</Badge>
                                                    )}
                                                </p>
                                            </div>
                                            <div>
                                                <p className="text-sm font-medium text-muted-foreground">Session Source</p>
                                                <p className="text-sm mt-1 capitalize">
                                                    {integration?.ui_session?.source ? integration.ui_session.source.replace("_", " ") : "—"}
                                                </p>
                                            </div>
                                            <div>
                                                <p className="text-sm font-medium text-muted-foreground">Last Session Refresh</p>
                                                <p className="text-sm mt-1 flex items-center gap-1">
                                                    <Clock className="h-3 w-3 text-muted-foreground" />
                                                    {integration?.ui_session?.last_created_at
                                                        ? new Date(integration.ui_session.last_created_at).toLocaleString()
                                                        : "Never"}
                                                </p>
                                            </div>
                                        </div>
                                    </CardContent>
                                </Card>
                            )}
                        </>
                    ) : (
                        <div className="space-y-4">
                            {isSalesforceProject ? (
                                /* ── Unified inline Salesforce Connection form ── */
                                <div className="rounded-xl border-2 border-blue-200 dark:border-blue-900 bg-gradient-to-br from-blue-50/60 to-indigo-50/40 dark:from-blue-950/20 dark:to-indigo-950/10 p-6 space-y-5">

                                    {/* Header */}
                                    <div className="flex items-center gap-3">
                                        <div className="p-2 rounded-lg bg-blue-600 text-white">
                                            <Cloud className="h-5 w-5" />
                                        </div>
                                        <div>
                                            <h3 className="font-semibold text-gray-900 dark:text-gray-100 text-base">Connect to Salesforce</h3>
                                            <p className="text-xs text-muted-foreground">All credentials are encrypted and stored securely per environment</p>
                                        </div>
                                    </div>

                                    {/* Error banner */}
                                    {sfIConnectError && (
                                        <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/30 dark:border-red-800 px-4 py-3 text-sm text-red-700 dark:text-red-400">
                                            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                                            <span>{sfIConnectError}</span>
                                        </div>
                                    )}

                                    {/* Success state */}
                                    {sfISuccess ? (
                                        <div className="rounded-lg border border-green-200 bg-green-50 dark:bg-green-950/30 dark:border-green-800 px-5 py-4 space-y-2">
                                            <p className="text-sm font-semibold text-green-800 dark:text-green-300 mb-3">Connected — refreshing status…</p>
                                            <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
                                                <Check className="h-4 w-4 shrink-0" />
                                                <span>Connected via Connected App (OAuth)</span>
                                            </div>
                                            <div className="flex items-center gap-2 text-sm">
                                                {sfISuccess.mcp
                                                    ? <Check className="h-4 w-4 shrink-0 text-green-600" />
                                                    : <AlertCircle className="h-4 w-4 shrink-0 text-amber-500" />}
                                                <span className={sfISuccess.mcp ? "text-green-700 dark:text-green-400" : "text-amber-700 dark:text-amber-400"}>
                                                    {sfISuccess.mcp ? "MCP Server connected" : "MCP connection skipped — retry from Integration tab after refresh"}
                                                </span>
                                            </div>
                                            <div className="flex items-center gap-2 text-sm">
                                                {sfISuccess.sync
                                                    ? <Check className="h-4 w-4 shrink-0 text-green-600" />
                                                    : <div className="h-4 w-4 shrink-0 rounded-full border border-gray-300" />}
                                                <span className={sfISuccess.sync ? "text-green-700 dark:text-green-400" : "text-muted-foreground"}>
                                                    {sfISuccess.sync ? "Metadata sync started" : "Metadata sync will start after MCP connects"}
                                                </span>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="grid gap-4 max-w-lg">

                                            {/* Username */}
                                            <div>
                                                <label className={labelClass}>Salesforce Username <span className="text-red-500">*</span></label>
                                                <input
                                                    type="text"
                                                    placeholder="e.g. admin@myorg.sandbox"
                                                    value={sfIUsername}
                                                    onChange={(e) => { setSfIUsername(e.target.value); if (sfIUsernameErr) setSfIUsernameErr(null) }}
                                                    className={inputClass + (sfIUsernameErr ? " border-red-500" : "")}
                                                    autoComplete="off"
                                                />
                                                {sfIUsernameErr && <p className="text-xs text-red-600 mt-1">{sfIUsernameErr}</p>}
                                            </div>

                                            {/* Password */}
                                            <div>
                                                <label className={labelClass}>Salesforce Password <span className="text-red-500">*</span></label>
                                                <div className="relative">
                                                    <input
                                                        type={sfIShowPassword ? "text" : "password"}
                                                        placeholder="Your Salesforce password"
                                                        value={sfIPassword}
                                                        onChange={(e) => { setSfIPassword(e.target.value); if (sfIPasswordErr) setSfIPasswordErr(null) }}
                                                        className={inputClass + (sfIPasswordErr ? " border-red-500" : "") + " pr-10"}
                                                        autoComplete="new-password"
                                                    />
                                                    <button type="button" onClick={() => setSfIShowPassword(!sfIShowPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                                                        {sfIShowPassword ? "🙈" : "👁"}
                                                    </button>
                                                </div>
                                                {sfIPasswordErr && <p className="text-xs text-red-600 mt-1">{sfIPasswordErr}</p>}
                                            </div>

                                            {/* Security Token */}
                                            <div>
                                                <label className={labelClass}>Security Token</label>
                                                <div className="relative">
                                                    <input
                                                        type={sfIShowToken ? "text" : "password"}
                                                        placeholder="Your Salesforce security token"
                                                        value={sfISecurityToken}
                                                        onChange={(e) => setSfISecurityToken(e.target.value)}
                                                        className={inputClass + " pr-10"}
                                                        autoComplete="new-password"
                                                    />
                                                    <button type="button" onClick={() => setSfIShowToken(!sfIShowToken)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                                                        {sfIShowToken ? "🙈" : "👁"}
                                                    </button>
                                                </div>
                                                <p className="text-xs text-muted-foreground mt-1">
                                                    Salesforce → Settings → My Personal Information → Reset My Security Token
                                                </p>
                                            </div>

                                            <hr className="border-border" />

                                            {/* Client ID */}
                                            <div>
                                                <label className={labelClass}>Connected App Client ID <span className="text-red-500">*</span></label>
                                                <input
                                                    type="text"
                                                    placeholder="Enter Consumer Key from Connected App"
                                                    value={sfIClientId}
                                                    onChange={(e) => { setSfIClientId(e.target.value); if (sfIClientIdErr) setSfIClientIdErr(null) }}
                                                    className={inputClass + (sfIClientIdErr ? " border-red-500" : "")}
                                                    autoComplete="off"
                                                />
                                                {sfIClientIdErr && <p className="text-xs text-red-600 mt-1">{sfIClientIdErr}</p>}
                                            </div>

                                            {/* Client Secret */}
                                            <div>
                                                <label className={labelClass}>Connected App Client Secret <span className="text-red-500">*</span></label>
                                                <div className="relative">
                                                    <input
                                                        type={sfIShowSecret ? "text" : "password"}
                                                        placeholder="Enter Consumer Secret"
                                                        value={sfIClientSecret}
                                                        onChange={(e) => { setSfIClientSecret(e.target.value); if (sfIClientSecretErr) setSfIClientSecretErr(null) }}
                                                        className={inputClass + (sfIClientSecretErr ? " border-red-500" : "") + " pr-10"}
                                                        autoComplete="new-password"
                                                    />
                                                    <button type="button" onClick={() => setSfIShowSecret(!sfIShowSecret)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                                                        {sfIShowSecret ? "🙈" : "👁"}
                                                    </button>
                                                </div>
                                                {sfIClientSecretErr && <p className="text-xs text-red-600 mt-1">{sfIClientSecretErr}</p>}
                                            </div>

                                            {/* Callback URL */}
                                            <div>
                                                <label className={labelClass}>Callback URL</label>
                                                <div className="flex gap-2">
                                                    <input
                                                        type="text"
                                                        value={sfIRedirectUri}
                                                        readOnly
                                                        className={inputClass + " font-mono text-xs bg-muted flex-1"}
                                                    />
                                                    <Button
                                                        type="button"
                                                        variant="outline"
                                                        size="sm"
                                                        onClick={() => { navigator.clipboard.writeText(sfIRedirectUri); toast.success("Copied!") }}
                                                    >
                                                        Copy
                                                    </Button>
                                                </div>
                                                <p className="text-xs text-muted-foreground mt-1">Add this to your Salesforce Connected App settings.</p>
                                            </div>

                                            {/* Login URL */}
                                            <div>
                                                <label className={labelClass}>Login URL</label>
                                                <select
                                                    value={sfILoginUrl}
                                                    onChange={(e) => setSfILoginUrl(e.target.value)}
                                                    className={inputClass}
                                                >
                                                    <option value="https://login.salesforce.com">Production (login.salesforce.com)</option>
                                                    <option value="https://test.salesforce.com">Sandbox (test.salesforce.com)</option>
                                                </select>
                                            </div>

                                            {/* Connect button */}
                                            <Button
                                                onClick={handleInlineConnect}
                                                disabled={sfIConnecting}
                                                className="w-full h-11 text-base font-semibold bg-blue-600 hover:bg-blue-700 mt-1"
                                            >
                                                {sfIConnecting
                                                    ? <><Loader2 className="mr-2 h-5 w-5 animate-spin" />Connecting…</>
                                                    : <><Zap className="mr-2 h-5 w-5" />Connect to Salesforce</>}
                                            </Button>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                /* Non-Salesforce / Web App fallback */
                                <Card className="border-2 border-blue-100 dark:border-blue-900">
                                    <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                                        <div className="bg-blue-100 dark:bg-blue-900/40 p-4 rounded-full mb-4">
                                            <Globe className="h-8 w-8 text-blue-600" />
                                        </div>
                                        <h3 className="text-lg font-semibold mb-2">Web App Not Connected</h3>
                                        <p className="text-muted-foreground mb-2 max-w-md">
                                            Your project is connected as a <strong>Web App</strong>. To enable Playwright metadata sync, ensure your project has a <strong>Base URL</strong> configured.
                                        </p>
                                        <p className="text-xs text-muted-foreground mb-6 max-w-sm">
                                            Once connected, click <strong>Sync Metadata</strong> to start crawling your web app and build the AI knowledge base for test generation.
                                        </p>
                                        <Button onClick={handleConnect} className="bg-blue-600 hover:bg-blue-700">
                                            <Globe className="mr-2 h-4 w-4" /> Configure Web App Connection
                                        </Button>
                                    </CardContent>
                                </Card>
                            )}
                        </div>
                    )}
                </TabsContent>

                {/* Artifacts Tab */}
                <TabsContent value="artifacts" className="space-y-4">
                    {/* Project Documents Panel */}
                    <Card className="border-teal-200 dark:border-teal-900 overflow-hidden">
                        <CardHeader className="pb-3">
                            <div className="flex items-center gap-2">
                                <FolderOpen className="h-5 w-5 text-teal-600" />
                                <CardTitle className="text-lg">Project Documents</CardTitle>
                                {(brdDocs.length + testCaseDocs.length) > 0 && (
                                    <Badge className="bg-teal-100 text-teal-700 border-teal-200">
                                        {brdDocs.length + testCaseDocs.length} file{(brdDocs.length + testCaseDocs.length) !== 1 ? 's' : ''}
                                    </Badge>
                                )}
                            </div>
                            <CardDescription>
                                Upload your BRD, Functional Spec, or Existing Test Cases so the AI can generate smarter, context-aware test scenarios tailored to your requirements.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-6">
                            {/* BRD / Functional Spec Section */}
                            <div className="space-y-3">
                                <div className="flex items-center gap-2">
                                    <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-blue-100 dark:bg-blue-900/40">
                                        <BookOpen className="h-4 w-4 text-blue-600" />
                                    </div>
                                    <div>
                                        <p className="text-sm font-semibold text-foreground">BRD / Functional Specification</p>
                                        <p className="text-xs text-muted-foreground">Accepts PDF, Word (.doc, .docx), or Plain Text (.txt) · Max 20 MB</p>
                                    </div>
                                </div>
                                <div
                                    onClick={() => brdFileInputRef.current?.click()}
                                    onDragOver={e => { e.preventDefault(); setBrdDragOver(true) }}
                                    onDragLeave={() => setBrdDragOver(false)}
                                    onDrop={e => {
                                        e.preventDefault()
                                        setBrdDragOver(false)
                                        handleBrdFileUpload(e.dataTransfer.files)
                                    }}
                                    className={`cursor-pointer border-2 border-dashed rounded-xl py-7 px-4 text-center transition-all duration-200 ${
                                        brdDragOver
                                            ? 'border-blue-500 bg-blue-50/80 dark:bg-blue-950/30 scale-[1.01]'
                                            : 'border-blue-200 dark:border-blue-800 hover:border-blue-400 hover:bg-blue-50/50 dark:hover:bg-blue-950/20'
                                    }`}
                                >
                                    {brdUploading ? (
                                        <div className="flex flex-col items-center gap-2">
                                            <Loader2 className="h-7 w-7 text-blue-500 animate-spin" />
                                            <p className="text-sm text-blue-600 font-medium">Uploading document…</p>
                                        </div>
                                    ) : (
                                        <div className="flex flex-col items-center gap-2">
                                            <div className="w-11 h-11 rounded-full bg-blue-100 dark:bg-blue-900/40 flex items-center justify-center">
                                                <UploadCloud className="h-5 w-5 text-blue-600" />
                                            </div>
                                            <p className="text-sm font-medium text-blue-700 dark:text-blue-300">
                                                {brdDragOver ? 'Release to upload' : 'Drop files here or click to browse'}
                                            </p>
                                            <p className="text-xs text-muted-foreground">PDF · Word · Text</p>
                                        </div>
                                    )}
                                </div>
                                <input
                                    ref={brdFileInputRef}
                                    type="file"
                                    accept=".pdf,.doc,.docx,.txt,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
                                    multiple
                                    className="hidden"
                                    onChange={e => { handleBrdFileUpload(e.target.files); e.target.value = '' }}
                                />
                                {brdDocs.length > 0 && (
                                    <div className="space-y-2">
                                        {brdDocs.map(doc => (
                                            <div key={doc.id} className="flex items-center gap-3 rounded-lg border border-blue-100 dark:border-blue-900 bg-blue-50/60 dark:bg-blue-950/20 px-3 py-2.5 group hover:border-blue-300 transition-all">
                                                <span className="text-lg flex-shrink-0">{getDocIcon(doc.name)}</span>
                                                <div className="flex-1 min-w-0">
                                                    <p className="text-sm font-medium truncate">{doc.name}</p>
                                                    <p className="text-xs text-muted-foreground">{formatFileSize(doc.size)} · Uploaded {new Date(doc.uploadedAt).toLocaleDateString()}</p>
                                                </div>
                                                <Badge className="bg-blue-100 text-blue-700 border-blue-200 text-xs flex-shrink-0"><CheckCircle2 className="h-3 w-3 mr-1" />Ready</Badge>
                                                <button onClick={() => removeBrdDoc(doc.id)} className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-500 transition-all flex-shrink-0" title="Remove document"><X className="h-4 w-4" /></button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                            <div className="flex items-center gap-3">
                                <div className="flex-1 h-px bg-border" />
                                <span className="text-xs text-muted-foreground font-medium px-1">AND</span>
                                <div className="flex-1 h-px bg-border" />
                            </div>
                            {/* Existing Test Cases Section */}
                            <div className="space-y-3">
                                <div className="flex items-center gap-2">
                                    <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-emerald-100 dark:bg-emerald-900/40">
                                        <TestTube2 className="h-4 w-4 text-emerald-600" />
                                    </div>
                                    <div>
                                        <p className="text-sm font-semibold text-foreground">Existing Test Cases</p>
                                        <p className="text-xs text-muted-foreground">Accepts CSV, Excel (.xls, .xlsx), or Word (.doc, .docx) · Max 20 MB</p>
                                    </div>
                                </div>
                                <div
                                    onClick={() => testCaseFileInputRef.current?.click()}
                                    onDragOver={e => { e.preventDefault(); setTestCaseDragOver(true) }}
                                    onDragLeave={() => setTestCaseDragOver(false)}
                                    onDrop={e => {
                                        e.preventDefault()
                                        setTestCaseDragOver(false)
                                        handleTestCaseFileUpload(e.dataTransfer.files)
                                    }}
                                    className={`cursor-pointer border-2 border-dashed rounded-xl py-7 px-4 text-center transition-all duration-200 ${
                                        testCaseDragOver
                                            ? 'border-emerald-500 bg-emerald-50/80 dark:bg-emerald-950/30 scale-[1.01]'
                                            : 'border-emerald-200 dark:border-emerald-800 hover:border-emerald-400 hover:bg-emerald-50/50 dark:hover:bg-emerald-950/20'
                                    }`}
                                >
                                    {testCaseUploading ? (
                                        <div className="flex flex-col items-center gap-2">
                                            <Loader2 className="h-7 w-7 text-emerald-500 animate-spin" />
                                            <p className="text-sm text-emerald-600 font-medium">Uploading file…</p>
                                        </div>
                                    ) : (
                                        <div className="flex flex-col items-center gap-2">
                                            <div className="w-11 h-11 rounded-full bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center">
                                                <FileSpreadsheet className="h-5 w-5 text-emerald-600" />
                                            </div>
                                            <p className="text-sm font-medium text-emerald-700 dark:text-emerald-300">
                                                {testCaseDragOver ? 'Release to upload' : 'Drop files here or click to browse'}
                                            </p>
                                            <p className="text-xs text-muted-foreground">CSV · Excel · Word</p>
                                        </div>
                                    )}
                                </div>
                                <input
                                    ref={testCaseFileInputRef}
                                    type="file"
                                    accept=".csv,.xls,.xlsx,.doc,.docx,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                                    multiple
                                    className="hidden"
                                    onChange={e => { handleTestCaseFileUpload(e.target.files); e.target.value = '' }}
                                />
                                {testCaseDocs.length > 0 && (
                                    <div className="space-y-2">
                                        {testCaseDocs.map(doc => (
                                            <div key={doc.id} className="flex items-center gap-3 rounded-lg border border-emerald-100 dark:border-emerald-900 bg-emerald-50/60 dark:bg-emerald-950/20 px-3 py-2.5 group hover:border-emerald-300 transition-all">
                                                <span className="text-lg flex-shrink-0">{getDocIcon(doc.name)}</span>
                                                <div className="flex-1 min-w-0">
                                                    <p className="text-sm font-medium truncate">{doc.name}</p>
                                                    <p className="text-xs text-muted-foreground">{formatFileSize(doc.size)} · Uploaded {new Date(doc.uploadedAt).toLocaleDateString()}</p>
                                                </div>
                                                <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 text-xs flex-shrink-0"><CheckCircle2 className="h-3 w-3 mr-1" />Ready</Badge>
                                                <button onClick={() => removeTestCaseDoc(doc.id)} className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-500 transition-all flex-shrink-0" title="Remove file"><X className="h-4 w-4" /></button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                            <div className="rounded-lg bg-teal-50/70 dark:bg-teal-950/20 border border-teal-200 dark:border-teal-800 p-3 flex items-start gap-2.5">
                                <span className="mt-0.5 text-base">💡</span>
                                <p className="text-xs text-teal-800 dark:text-teal-300 leading-relaxed">
                                    <span className="font-semibold">Pro tip:</span> The AI uses your BRD and existing test cases as context when generating new test scenarios — ensuring generated tests align with your business requirements and avoid duplicating coverage already defined.
                                </p>
                            </div>
                        </CardContent>
                    </Card>

                    {/* Test Data Panel */}
                    <Card className="border-violet-200 dark:border-violet-900 overflow-hidden">
                        <CardHeader className="pb-3">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <Database className="h-5 w-5 text-violet-600" />
                                    <CardTitle className="text-lg">Test Data</CardTitle>
                                    {testDataEntities.length > 0 && (
                                        <Badge className="bg-violet-100 text-violet-700 border-violet-200">
                                            {testDataEntities.length} {testDataEntities.length === 1 ? 'entity' : 'entities'}
                                        </Badge>
                                    )}
                                </div>
                                <div className="flex items-center gap-2">
                                    {testDataEntities.length > 0 && (
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            onClick={handleClearTestData}
                                            className="text-red-600 border-red-200 hover:bg-red-50 dark:hover:bg-red-950/20 text-xs"
                                        >
                                            <Trash2 className="mr-1 h-3 w-3" />Clear All
                                        </Button>
                                    )}
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={handleExtractTestData}
                                        disabled={testDataExtracting || testDataLoading}
                                        className="text-violet-700 border-violet-300 hover:bg-violet-50"
                                    >
                                        {testDataExtracting
                                            ? <><Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />Extracting…</>
                                            : <><Search className="mr-2 h-3.5 w-3.5" />Extract from UI</>}
                                    </Button>
                                </div>
                            </div>
                            <CardDescription>
                                Real records from your app are used by the AI to generate test steps with valid values.
                                Extract automatically from list pages, or upload a JSON file as fallback.
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-5">
                            {testDataEntities.length > 0 ? (
                                <div className="rounded-lg border border-violet-100 dark:border-violet-900 overflow-hidden">
                                    <table className="w-full text-sm">
                                        <thead className="bg-violet-50 dark:bg-violet-950/30">
                                            <tr>
                                                <th className="text-left px-4 py-2.5 font-medium text-violet-800 dark:text-violet-300">Entity</th>
                                                <th className="text-left px-4 py-2.5 font-medium text-violet-800 dark:text-violet-300">Records</th>
                                                <th className="text-left px-4 py-2.5 font-medium text-violet-800 dark:text-violet-300">Source</th>
                                                <th className="text-left px-4 py-2.5 font-medium text-violet-800 dark:text-violet-300">Last Updated</th>
                                                <th className="w-8 px-2 py-2.5"></th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {testDataEntities.map((e, i) => (
                                                <tr key={e.entity_name} className={`group ${i % 2 === 0 ? 'bg-white dark:bg-transparent' : 'bg-violet-50/40 dark:bg-violet-950/10'}`}>
                                                    <td className="px-4 py-2.5 font-medium">{e.entity_name}</td>
                                                    <td className="px-4 py-2.5"><Badge variant="outline" className="font-mono">{e.record_count}</Badge></td>
                                                    <td className="px-4 py-2.5">
                                                        {e.source === 'user_upload'
                                                            ? <Badge className="bg-amber-100 text-amber-700 border-amber-200 text-xs">⭐ User Upload</Badge>
                                                            : e.source === 'api'
                                                            ? <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 text-xs">🔌 OpenAPI</Badge>
                                                            : <Badge className="bg-blue-100 text-blue-700 border-blue-200 text-xs">🤖 UI Scraped</Badge>
                                                        }
                                                    </td>
                                                    <td className="px-4 py-2.5 text-muted-foreground text-xs">{new Date(e.last_extracted_at).toLocaleDateString()}</td>
                                                    <td className="px-2 py-2.5 text-right">
                                                        <button
                                                            onClick={() => handleDeleteTestDataEntity(e.entity_name)}
                                                            title={`Remove "${e.entity_name}"`}
                                                            className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-500 transition-all"
                                                        >
                                                            <X className="h-3.5 w-3.5" />
                                                        </button>
                                                    </td>
                                                </tr>
                                            ))}
                                        </tbody>
                                    </table>
                                </div>
                            ) : (
                                <div className="text-center py-6 text-muted-foreground text-sm">
                                    <Database className="h-10 w-10 mx-auto mb-2 opacity-30" />
                                    No test data yet. Extract from UI or upload a JSON file below.
                                </div>
                            )}

                            <div className="space-y-3">
                                <p className="text-sm font-medium text-foreground flex items-center gap-1.5">
                                    <span>📤</span> Upload Sample Test Data
                                    <span className="text-xs text-muted-foreground font-normal ml-1">(optional fallback)</span>
                                </p>
                                <div
                                    onClick={() => fileInputRef.current?.click()}
                                    onDragOver={e => e.preventDefault()}
                                    onDrop={e => {
                                        e.preventDefault()
                                        const file = e.dataTransfer.files?.[0]
                                        if (file) handleTestDataFileUpload(file)
                                    }}
                                    className="cursor-pointer border-2 border-dashed border-violet-200 dark:border-violet-800 rounded-xl py-6 px-4 text-center hover:border-violet-400 hover:bg-violet-50/50 dark:hover:bg-violet-950/20 transition-all"
                                >
                                    {testDataUploading ? (
                                        <div className="flex flex-col items-center gap-2">
                                            <Loader2 className="h-7 w-7 text-violet-500 animate-spin" />
                                            <p className="text-sm text-violet-600">Uploading…</p>
                                        </div>
                                    ) : (
                                        <div className="flex flex-col items-center gap-2">
                                            <div className="w-10 h-10 rounded-full bg-violet-100 dark:bg-violet-900/40 flex items-center justify-center">
                                                <span className="text-lg">📂</span>
                                            </div>
                                            <p className="text-sm font-medium text-violet-700 dark:text-violet-300">Drop your JSON file here or click to browse</p>
                                            <p className="text-xs text-muted-foreground">Format: {'{ "Account": [{"name": "Acme", "industry": "Tech"}], "Contact": [...] }'}</p>
                                        </div>
                                    )}
                                </div>
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    accept=".json,application/json"
                                    className="hidden"
                                    onChange={e => {
                                        const file = e.target.files?.[0]
                                        if (file) handleTestDataFileUpload(file)
                                        e.target.value = ''
                                    }}
                                />
                                {uploadResult && (
                                    <div className={`rounded-lg p-3 text-sm flex items-start gap-2 ${
                                        uploadResult.success
                                            ? 'bg-green-50 border border-green-200 dark:bg-green-950/20 dark:border-green-800'
                                            : 'bg-red-50 border border-red-200'
                                    }`}>
                                        <span className="mt-0.5">{uploadResult.success ? '✅' : '❌'}</span>
                                        <div>
                                            <p className={`font-medium ${uploadResult.success ? 'text-green-800 dark:text-green-300' : 'text-red-700'}`}>{uploadResult.message}</p>
                                            {uploadResult.preview && (
                                                <p className="text-xs text-muted-foreground mt-0.5">
                                                    {Object.entries(uploadResult.preview).map(([k, v]) => `${k}: ${v} records`).join(' · ')}
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                )}
                                {uploadError && (
                                    <div className="rounded-lg p-3 text-sm bg-red-50 border border-red-200 text-red-700 flex items-center gap-2">
                                        <span>❌</span> {uploadError}
                                    </div>
                                )}
                                <div className="rounded-lg bg-muted/50 border p-3 text-xs text-muted-foreground">
                                    <p className="font-medium mb-1 text-foreground">Expected JSON format:</p>
                                    <pre className="font-mono whitespace-pre-wrap">{'{'}
  "Account": [
    {'{'} "name": "Acme Corp", "industry": "Technology" {'}'}
  ],
  "Contact": [
    {'{'} "name": "Jane Smith", "email": "jane@acme.com" {'}'}
  ]
{'}'}</pre>
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>

                {/* MCP Operations Tab */}
                {isConnected && isMcp && (
                    <TabsContent value="mcp-ops" className="space-y-4">
                        <Card>
                            <CardHeader>
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <Database className="h-5 w-5 text-orange-500" />
                                        <CardTitle>Salesforce MCP Operations</CardTitle>
                                    </div>
                                    <Button variant="outline" size="sm" onClick={handleFetchLimits} disabled={limitsLoading}>
                                        {limitsLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <BarChart3 className="mr-2 h-4 w-4" />}
                                        Org Limits
                                    </Button>
                                </div>
                            </CardHeader>
                            <CardContent>
                                {/* CRUD Sub-tabs */}
                                <div className="flex gap-2 mb-4 border-b pb-2">
                                    {[
                                        { key: "query", label: "SOQL Query", icon: <Search className="h-3 w-3" /> },
                                        { key: "create", label: "Create", icon: <Plus className="h-3 w-3" /> },
                                        { key: "update", label: "Update", icon: <Edit className="h-3 w-3" /> },
                                        { key: "delete", label: "Delete", icon: <Trash2 className="h-3 w-3" /> },
                                    ].map((tab) => (
                                        <button
                                            key={tab.key}
                                            onClick={() => setCrudTab(tab.key)}
                                            className={`flex items-center gap-1 px-3 py-1.5 text-sm rounded-md font-medium transition-colors ${crudTab === tab.key
                                                ? "bg-orange-100 text-orange-700 dark:bg-orange-950 dark:text-orange-300"
                                                : "text-muted-foreground hover:bg-gray-100 dark:hover:bg-gray-800"
                                                }`}
                                        >
                                            {tab.icon} {tab.label}
                                        </button>
                                    ))}
                                </div>

                                {/* SOQL Query */}
                                {crudTab === "query" && (
                                    <div className="space-y-3">
                                        <div>
                                            <label className={labelClass}>SOQL Query</label>
                                            <textarea
                                                value={soqlQuery}
                                                onChange={(e) => setSoqlQuery(e.target.value)}
                                                rows={3}
                                                className={inputClass + " font-mono text-xs"}
                                                placeholder="SELECT Id, Name FROM Account LIMIT 10"
                                            />
                                        </div>
                                        <Button onClick={handleQuery} disabled={queryLoading} size="sm" className="bg-orange-600 hover:bg-orange-700">
                                            {queryLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
                                            Execute Query
                                        </Button>
                                        {queryResults && (
                                            <div className="mt-4">
                                                <p className="text-sm text-muted-foreground mb-2">
                                                    Results: {queryResults.total_size} record(s)
                                                </p>
                                                <div className="max-h-80 overflow-auto border rounded-md">
                                                    <table className="w-full text-xs">
                                                        <thead className="bg-gray-50 dark:bg-gray-900 sticky top-0">
                                                            <tr>
                                                                {queryResults.records?.[0] &&
                                                                    Object.keys(queryResults.records[0])
                                                                        .filter((k) => k !== "attributes")
                                                                        .map((key) => (
                                                                            <th key={key} className="px-3 py-2 text-left font-medium text-muted-foreground border-b">
                                                                                {key}
                                                                            </th>
                                                                        ))}
                                                            </tr>
                                                        </thead>
                                                        <tbody>
                                                            {queryResults.records?.map((record: any, i: number) => (
                                                                <tr key={i} className="border-b hover:bg-gray-50 dark:hover:bg-gray-900">
                                                                    {Object.entries(record)
                                                                        .filter(([k]) => k !== "attributes")
                                                                        .map(([key, val]) => (
                                                                            <td key={key} className="px-3 py-2 truncate max-w-[200px]">
                                                                                {typeof val === "object" ? JSON.stringify(val) : String(val ?? "")}
                                                                            </td>
                                                                        ))}
                                                                </tr>
                                                            ))}
                                                        </tbody>
                                                    </table>
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                )}

                                {/* Create Record */}
                                {crudTab === "create" && (
                                    <div className="space-y-3 max-w-lg">
                                        <div>
                                            <label className={labelClass}>Object Type</label>
                                            <input type="text" value={createObjectType} onChange={(e) => setCreateObjectType(e.target.value)} className={inputClass} placeholder="Account" />
                                        </div>
                                        <div>
                                            <label className={labelClass}>Record Data (JSON)</label>
                                            <textarea value={createData} onChange={(e) => setCreateData(e.target.value)} rows={4} className={inputClass + " font-mono text-xs"} placeholder='{"Name": "Test Account"}' />
                                        </div>
                                        <Button onClick={handleCreateRecord} disabled={createLoading} size="sm" className="bg-green-600 hover:bg-green-700">
                                            {createLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
                                            Create Record
                                        </Button>
                                    </div>
                                )}

                                {/* Update Record */}
                                {crudTab === "update" && (
                                    <div className="space-y-3 max-w-lg">
                                        <div>
                                            <label className={labelClass}>Object Type</label>
                                            <input type="text" value={updateObjectType} onChange={(e) => setUpdateObjectType(e.target.value)} className={inputClass} placeholder="Account" />
                                        </div>
                                        <div>
                                            <label className={labelClass}>Record ID</label>
                                            <input type="text" value={updateRecordId} onChange={(e) => setUpdateRecordId(e.target.value)} className={inputClass} placeholder="001XX000003DHPh" />
                                        </div>
                                        <div>
                                            <label className={labelClass}>Update Data (JSON)</label>
                                            <textarea value={updateData} onChange={(e) => setUpdateData(e.target.value)} rows={4} className={inputClass + " font-mono text-xs"} placeholder='{"Name": "Updated Name"}' />
                                        </div>
                                        <Button onClick={handleUpdateRecord} disabled={updateLoading} size="sm" className="bg-blue-600 hover:bg-blue-700">
                                            {updateLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Edit className="mr-2 h-4 w-4" />}
                                            Update Record
                                        </Button>
                                    </div>
                                )}

                                {/* Delete Record */}
                                {crudTab === "delete" && (
                                    <div className="space-y-3 max-w-lg">
                                        <div>
                                            <label className={labelClass}>Object Type</label>
                                            <input type="text" value={deleteObjectType} onChange={(e) => setDeleteObjectType(e.target.value)} className={inputClass} placeholder="Account" />
                                        </div>
                                        <div>
                                            <label className={labelClass}>Record ID</label>
                                            <input type="text" value={deleteRecordId} onChange={(e) => setDeleteRecordId(e.target.value)} className={inputClass} placeholder="001XX000003DHPh" />
                                        </div>
                                        <Button onClick={handleDeleteRecord} disabled={deleteLoading} size="sm" variant="destructive">
                                            {deleteLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                                            Delete Record
                                        </Button>
                                    </div>
                                )}
                            </CardContent>
                        </Card>

                        {/* Org Limits */}
                        {orgLimits && (
                            <Card>
                                <CardHeader>
                                    <CardTitle className="text-lg">Organization API Limits</CardTitle>
                                </CardHeader>
                                <CardContent>
                                    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                                        {Object.entries(orgLimits).map(([key, val]: [string, any]) => (
                                            <div key={key} className="p-3 rounded-md border">
                                                <p className="text-xs font-medium text-muted-foreground">{key}</p>
                                                <p className="text-sm font-bold mt-1">
                                                    {val?.Remaining ?? "—"} / {val?.Max ?? "—"}
                                                </p>
                                                {val?.Max > 0 && (
                                                    <div className="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full mt-1">
                                                        <div
                                                            className="h-full bg-orange-500 rounded-full"
                                                            style={{ width: `${Math.min(100, ((val.Max - val.Remaining) / val.Max) * 100)}%` }}
                                                        />
                                                    </div>
                                                )}
                                            </div>
                                        ))}
                                    </div>
                                </CardContent>
                            </Card>
                        )}
                    </TabsContent>
                )}


                {/* Settings Tab */}
                <TabsContent value="settings" className="space-y-4">
                    <Card>
                        <CardHeader><CardTitle>Jira Integration</CardTitle><CardDescription>Configure Jira connection for this project</CardDescription></CardHeader>
                        <CardContent><p className="text-sm text-muted-foreground">General settings coming soon...</p></CardContent>
                    </Card>

                    {/* Jira Integration Card */}
                    <Card className="border-purple-200 dark:border-purple-900">
                        <CardHeader>
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <svg className="h-5 w-5 text-purple-600" viewBox="0 0 24 24" fill="currentColor">
                                        <path d="M11.53 2c0 2.4 1.97 4.35 4.35 4.35h1.78v1.7c0 2.4 1.94 4.34 4.34 4.35V2.84a.84.84 0 0 0-.84-.84H11.53zM6.77 6.8a4.36 4.36 0 0 0 4.34 4.34h1.8v1.72a4.36 4.36 0 0 0 4.34 4.34V7.63a.84.84 0 0 0-.83-.83H6.77zM2 11.6a4.35 4.35 0 0 0 4.34 4.34h1.8v1.72A4.35 4.35 0 0 0 12.48 22v-9.57a.84.84 0 0 0-.84-.84H2z" />
                                    </svg>
                                    <CardTitle>Jira Integration</CardTitle>
                                </div>
                                {jiraConfig && !jiraReconfiguring && (
                                    <Button variant="outline" size="sm" onClick={() => setJiraReconfiguring(true)}>
                                        <Settings className="mr-2 h-4 w-4" /> Reconfigure
                                    </Button>
                                )}
                            </div>
                            <CardDescription>Connect Jira to import user stories when creating test cases</CardDescription>
                        </CardHeader>
                        <CardContent>
                            {jiraConfigLoading ? (
                                <div className="flex justify-center py-4"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
                            ) : jiraConfig && !jiraReconfiguring ? (
                                <div className="space-y-3">
                                    <div className="flex items-center gap-2 p-3 bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800 rounded-md">
                                        <Check className="h-4 w-4 text-green-600" />
                                        <span className="text-sm text-green-700 dark:text-green-400 font-medium">Jira Connected</span>
                                    </div>
                                    <div className="grid grid-cols-2 gap-4">
                                        <div>
                                            <p className="text-sm font-medium text-muted-foreground">Domain</p>
                                            <p className="text-sm">{jiraConfig.jira_domain}</p>
                                        </div>
                                        <div>
                                            <p className="text-sm font-medium text-muted-foreground">Email</p>
                                            <p className="text-sm">{jiraConfig.jira_email}</p>
                                        </div>
                                        <div>
                                            <p className="text-sm font-medium text-muted-foreground">Board</p>
                                            <p className="text-sm font-medium">{jiraConfig.jira_board_name}</p>
                                        </div>
                                        <div>
                                            <p className="text-sm font-medium text-muted-foreground">Board ID</p>
                                            <p className="text-sm font-mono">{jiraConfig.jira_board_id}</p>
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <div className="space-y-4">
                                    {!jiraConnected ? (
                                        <div className="grid gap-4 max-w-lg">
                                            <div>
                                                <label className={labelClass}>Jira Domain</label>
                                                <input
                                                    type="text"
                                                    placeholder="https://yourcompany.atlassian.net"
                                                    value={jiraDomain}
                                                    onChange={(e) => { setJiraDomain(e.target.value); setJiraConnectError(null) }}
                                                    className={inputClass}
                                                />
                                                <p className="text-xs text-muted-foreground mt-1">Use your Jira Cloud site URL (e.g. https://yourteam.atlassian.net)</p>
                                            </div>
                                            <div>
                                                <label className={labelClass}>Email</label>
                                                <input
                                                    type="email"
                                                    placeholder="you@company.com"
                                                    value={jiraEmail}
                                                    onChange={(e) => { setJiraEmail(e.target.value); setJiraConnectError(null) }}
                                                    className={inputClass}
                                                />
                                            </div>
                                            <div>
                                                <label className={labelClass}>API Token</label>
                                                <input
                                                    type="password"
                                                    placeholder="Enter your Jira API token"
                                                    value={jiraApiToken}
                                                    onChange={(e) => { setJiraApiToken(e.target.value); setJiraConnectError(null) }}
                                                    className={inputClass}
                                                />
                                                <p className="text-xs text-muted-foreground mt-1">
                                                    <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer" className="text-purple-600 underline">Generate an API token</a> from your Atlassian account settings.
                                                </p>
                                            </div>

                                            {/* Error display */}
                                            {jiraConnectError && (
                                                <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800 rounded-md">
                                                    <AlertCircle className="h-4 w-4 text-red-600 mt-0.5 flex-shrink-0" />
                                                    <div>
                                                        <p className="text-sm font-medium text-red-700 dark:text-red-400">Connection failed</p>
                                                        <p className="text-xs text-red-600 dark:text-red-500 mt-0.5">{jiraConnectError}</p>
                                                    </div>
                                                </div>
                                            )}

                                            <div className="flex gap-2">
                                                <Button
                                                    onClick={handleJiraConnect}
                                                    disabled={jiraConnecting || !jiraDomain || !jiraEmail || !jiraApiToken}
                                                    className="bg-purple-600 hover:bg-purple-700"
                                                >
                                                    {jiraConnecting
                                                        ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Connecting...</>
                                                        : <><Link2 className="mr-2 h-4 w-4" />Connect & Fetch Boards</>
                                                    }
                                                </Button>
                                                {jiraReconfiguring && (
                                                    <Button variant="outline" onClick={() => { setJiraReconfiguring(false); setJiraConnectError(null) }}>Cancel</Button>
                                                )}
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="grid gap-4 max-w-lg">
                                            <div className="flex items-center gap-2">
                                                <Check className="h-4 w-4 text-green-600" />
                                                <span className="text-sm text-green-700 dark:text-green-400 font-medium">Connected to Jira</span>
                                            </div>
                                            <div>
                                                <label className={labelClass}>Select Board</label>
                                                <select value={selectedJiraBoard} onChange={(e) => { setSelectedJiraBoard(e.target.value); const b = jiraBoards.find(x => x.id === e.target.value); setSelectedJiraBoardName(b?.name || "") }} className={inputClass + " cursor-pointer"}>
                                                    {jiraBoards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                                                </select>
                                            </div>
                                            <div className="flex gap-2">
                                                <Button onClick={handleSaveJiraConfig} disabled={jiraSaving || !selectedJiraBoard} className="bg-purple-600 hover:bg-purple-700">
                                                    {jiraSaving ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving...</> : <><Check className="mr-2 h-4 w-4" />Save Jira Configuration</>}
                                                </Button>
                                                {jiraReconfiguring && (
                                                    <Button variant="outline" onClick={() => { setJiraReconfiguring(false); setJiraConnected(false) }}>Cancel</Button>
                                                )}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </TabsContent>

                {/* Generate Test Cases Tab */}
                <TabsContent value="generate" className="space-y-4">
                    <GenerateTestCasesTab
                        projectId={id}
                        projectName={project.name}
                        jiraConfigured={!!(jiraConfig?.configured)}
                        metadataSynced={!!(integration?.sync_counts && integration.sync_counts.embedding_count > 0)}
                    />
                </TabsContent>
            </Tabs>
        </div>
    )
}
