"use client"

import { useState, useEffect, use } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import {
    ArrowLeft, Loader2, Settings, FileText, BarChart3, Link2,
    Cloud, Globe, Check, X, RefreshCw, Unplug, Plug, AlertCircle,
    Key, Server, ExternalLink
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
    last_synced_at?: string
    sync_error?: string
    sync_counts?: {
        raw_count: number
        normalized_count: number
        domain_model_count: number
        embedding_count: number
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

    useEffect(() => {
        if (id) {
            fetchProject()
            fetchIntegration()
        }
        const connected = searchParams.get("connected")
        if (connected === "salesforce") toast.success("Salesforce connected & metadata sync started!")
        const error = searchParams.get("error")
        if (error) toast.error(`Connection error: ${error}`)
    }, [id])

    const fetchProject = async () => {
        try {
            const response = await fetch(`http://localhost:8000/api/v1/projects/${id}`)
            if (!response.ok) throw new Error("Failed to fetch project")
            setProject(await response.json())
        } catch { toast.error("Failed to load project") }
        finally { setIsLoading(false) }
    }

    const fetchIntegration = async () => {
        setIntegrationLoading(true)
        try {
            const response = await fetch(`http://localhost:8000/api/v1/projects/${id}/integration-status`)
            if (response.ok) setIntegration(await response.json())
        } catch (error) { console.error("Failed to fetch integration:", error) }
        finally { setIntegrationLoading(false) }
    }

    const handleSyncMetadata = async () => {
        setSyncing(true)
        try {
            const response = await fetch(`http://localhost:8000/api/v1/projects/${id}/sync-metadata`, { method: "POST" })
            const data = await response.json()
            if (data.status === "completed") toast.success("Metadata synced successfully!")
            else toast.error(data.message || "Sync failed")
            fetchIntegration()
        } catch { toast.error("Sync request failed") }
        finally { setSyncing(false) }
    }

    const handleDisconnect = async () => {
        if (!confirm("Are you sure you want to disconnect this integration?")) return
        setDisconnecting(true)
        try {
            const response = await fetch(`http://localhost:8000/api/v1/projects/${id}/disconnect`, { method: "DELETE" })
            if (response.ok || response.status === 204) {
                toast.success("Integration disconnected")
                setIntegration({ category: null, status: "disconnected" })
            }
        } catch { toast.error("Disconnect failed") }
        finally { setDisconnecting(false) }
    }

    const handleConnect = async () => {
        const cat = project?.category || "webapp"
        if (cat === "salesforce") {
            try {
                const response = await fetch(`http://localhost:8000/api/v1/projects/${id}/connect`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ category: "salesforce" }),
                })
                const data = await response.json()
                if (data.auth_url) window.location.href = data.auth_url
                else if (data.detail) toast.error(data.detail)
            } catch { toast.error("Failed to start Salesforce OAuth") }
        } else {
            router.push("/dashboard/projects/create")
        }
    }

    if (isLoading) return (
        <div className="flex items-center justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
    )
    if (!project) return (
        <div className="flex flex-col items-center justify-center py-16">
            <h3 className="text-lg font-semibold mb-2">Project not found</h3>
            <Button onClick={() => router.push("/dashboard/projects")}>Back to Projects</Button>
        </div>
    )

    const isConnected = integration?.status === "connected"
    const isSalesforce = integration?.category === "salesforce"
    const isApi = integration?.category === "api"

    const getCategoryIcon = () => {
        if (isSalesforce) return <Cloud className="h-5 w-5 text-purple-600" />
        if (isApi) return <Server className="h-5 w-5 text-green-600" />
        return <Globe className="h-5 w-5 text-blue-600" />
    }
    const getCategoryLabel = () => {
        if (isSalesforce) return "Salesforce Organization"
        if (isApi) return "API Service"
        return "Web Application"
    }

    return (
        <div className="space-y-6">
            {/* Breadcrumb */}
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Link href="/dashboard/projects" className="hover:text-foreground">Projects</Link>
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
                            <Badge className="bg-green-100 text-green-700 border-green-200">
                                <Check className="h-3 w-3 mr-1" /> Connected
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
                    <TabsTrigger value="tests"><FileText className="mr-2 h-4 w-4" /> Test Cases</TabsTrigger>
                    <TabsTrigger value="settings"><Settings className="mr-2 h-4 w-4" /> Settings</TabsTrigger>
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
                        <CardHeader><CardTitle>Project Information</CardTitle></CardHeader>
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
                                            <Badge className="bg-green-100 text-green-700">Connected</Badge>
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
                                        {integration?.salesforce_login_url && isSalesforce && (
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
                                        {isSalesforce && (
                                            <div>
                                                <p className="text-sm font-medium text-muted-foreground">Connected App</p>
                                                <p className="text-sm">
                                                    {integration?.has_sf_credentials ? (
                                                        <span className="text-green-600 flex items-center gap-1"><Check className="h-3 w-3" /> Per-project credentials</span>
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
                        </>
                    ) : (
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
                                    <Link2 className="mr-2 h-4 w-4" /> Connect to Project
                                </Button>
                            </CardContent>
                        </Card>
                    )}
                </TabsContent>

                {/* Test Cases Tab */}
                <TabsContent value="tests" className="space-y-4">
                    <Card>
                        <CardHeader><CardTitle>Test Cases</CardTitle><CardDescription>Manage test cases for this project</CardDescription></CardHeader>
                        <CardContent>
                            <div className="flex flex-col items-center justify-center py-8 text-center">
                                <FileText className="h-12 w-12 text-muted-foreground mb-4" />
                                <h3 className="text-lg font-semibold mb-2">No test cases yet</h3>
                                <p className="text-muted-foreground mb-4">Create your first test case to get started</p>
                                <Button>Create Test Case</Button>
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>

                {/* Settings Tab */}
                <TabsContent value="settings" className="space-y-4">
                    <Card>
                        <CardHeader><CardTitle>Project Settings</CardTitle><CardDescription>Configure project settings and preferences</CardDescription></CardHeader>
                        <CardContent><p className="text-sm text-muted-foreground">Settings panel coming soon...</p></CardContent>
                    </Card>
                </TabsContent>
            </Tabs>
        </div>
    )
}
