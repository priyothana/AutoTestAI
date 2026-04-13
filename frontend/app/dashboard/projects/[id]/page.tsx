"use client"

import { useState, useEffect, use } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
    ArrowLeft, Loader2, Settings, FileText, BarChart3, Link2,
    Cloud, Globe, Check, X, RefreshCw, Unplug, Plug, AlertCircle,
    Key, Server, ExternalLink, Clock, Database, Search, Plus, Trash2, Edit, Play, Zap
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { toast } from "sonner"
import Link from "next/link"

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

    useEffect(() => {
        if (id) {
            fetchProject()
            fetchIntegration()
            fetchJiraConfig()
        }
        const connected = searchParams.get("connected")
        if (connected === "salesforce") toast.success("Salesforce connected & metadata sync started!")
        const error = searchParams.get("error")
        if (error) toast.error(`Connection error: ${error}`)
    }, [id])

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
            if (response.ok) setIntegration(await response.json())
        } catch (error) { console.error("Failed to fetch integration:", error) }
        finally { setIntegrationLoading(false) }
    }

    const handleSyncMetadata = async () => {
        setSyncing(true)
        try {
            // Use MCP sync endpoint if connected via MCP, otherwise use standard sync
            const isMcpConn = integration?.mcp_connected
            const url = isMcpConn
                ? `${process.env.NEXT_PUBLIC_API_URL}/api/v1/mcp/projects/${id}/mcp/sync-metadata`
                : `${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${id}/sync-metadata`
            const response = await fetch(url, { method: "POST" })
            const data = await response.json()
            if (data.status === "completed") {
                toast.success(`Metadata synced! (${data.raw_count || 0} raw, ${data.normalized_count || 0} normalized, ${data.domain_model_count || 0} domain, ${data.embedding_count || 0} embeddings)`)
            } else {
                toast.error(data.message || "Sync failed")
            }
            fetchIntegration()
        } catch { toast.error("Sync request failed") }
        finally { setSyncing(false) }
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
            router.push("/dashboard/projects/create")
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
                    {isConnected && isMcp && (
                        <TabsTrigger value="mcp-ops"><Database className="mr-2 h-4 w-4" /> MCP Operations</TabsTrigger>
                    )}
                    <TabsTrigger value="settings"><Settings className="mr-2 h-4 w-4" /> Jira Integration</TabsTrigger>
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
                                            {(isSalesforce || isApi) && (
                                                <Button variant="outline" size="sm" onClick={handleSyncMetadata} disabled={syncing}>
                                                    {syncing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                                                    Resync Metadata
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
                                        { label: "Raw Metadata", count: integration.sync_counts.raw_count, color: "text-blue-600" },
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

                            {/* Session Status Card (OAuth Salesforce only) */}
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
                                /* Non-Salesforce fallback */
                                <Card>
                                    <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                                        <div className="bg-gray-100 dark:bg-gray-900 p-4 rounded-full mb-4">
                                            <Plug className="h-8 w-8 text-muted-foreground" />
                                        </div>
                                        <h3 className="text-lg font-semibold mb-2">No Integration Connected</h3>
                                        <p className="text-muted-foreground mb-6 max-w-md">
                                            Connect your project to enable authentication, metadata extraction, and AI-powered test generation.
                                        </p>
                                        <Button onClick={handleConnect} className="bg-blue-600 hover:bg-blue-700">
                                            <Link2 className="mr-2 h-4 w-4" /> Connect to Environment
                                        </Button>
                                    </CardContent>
                                </Card>
                            )}
                        </div>
                    )}
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
            </Tabs>
        </div>
    )
}
