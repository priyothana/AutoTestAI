"use client"

import { useState, useEffect } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import * as z from "zod"
import {
    Check, Globe, Smartphone, Server, ChevronRight, ChevronLeft,
    Cloud, Link2, Loader2, Eye, EyeOff, Key, Copy, Zap
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form"
import { toast } from "sonner"

const steps = [
    { id: 1, name: "Basics" },
    { id: 2, name: "Type" },
    { id: 3, name: "Configuration" },
    { id: 4, name: "Review" },
    { id: 5, name: "Connect" },
]

const TYPE_TO_CATEGORY: Record<string, string> = {
    WEB: "webapp",
    MOBILE: "webapp",
    API: "api",
    SALESFORCE: "salesforce",
}

const formSchema = z.object({
    name: z.string().min(2, "Name must be at least 2 characters"),
    description: z.string().optional(),
    type: z.enum(["WEB", "MOBILE", "API", "SALESFORCE"]),
    baseUrl: z.string().optional().or(z.literal("")),
}).superRefine((data, ctx) => {
    // Base URL is required for all non-Salesforce types
    if (data.type !== "SALESFORCE") {
        if (!data.baseUrl || !data.baseUrl.trim()) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Base URL is required",
                path: ["baseUrl"],
            })
        } else if (!/^https?:\/\/.+/.test(data.baseUrl)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "Must be a valid URL starting with http:// or https://",
                path: ["baseUrl"],
            })
        }
    }
})

export default function CreateProjectPage() {
    const router = useRouter()
    const searchParams = useSearchParams()
    const [currentStep, setCurrentStep] = useState(1)
    const [createdProjectId, setCreatedProjectId] = useState<string | null>(null)
    const [isCreating, setIsCreating] = useState(false)
    // Edit mode: set when arriving via ?edit=<id> so we update instead of create
    const [editProjectId, setEditProjectId] = useState<string | null>(null)
    const [isEditMode, setIsEditMode] = useState(false)

    // On mount: handle ?connect=<id> (Salesforce reconnect) and ?edit=<id> (web app reconnect)
    useEffect(() => {
        const connectId = searchParams.get("connect")
        const editId = searchParams.get("edit")

        if (connectId) {
            // Salesforce reconnect — jump straight to Connect step
            setCreatedProjectId(connectId)
            form.setValue("type", "SALESFORCE")
            setCurrentStep(5)
            return
        }

        if (editId) {
            // Web App reconnect — load existing project, pre-fill, skip to Connect step
            setEditProjectId(editId)
            setCreatedProjectId(editId)
            setIsEditMode(true)
            fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${editId}`)
                .then((r) => r.json())
                .then((project) => {
                    form.setValue("name", project.name ?? "")
                    form.setValue("description", project.description ?? "")
                    const typeKey = Object.entries(TYPE_TO_CATEGORY).find(
                        ([, cat]) => cat === project.category
                    )?.[0] as "WEB" | "MOBILE" | "API" | "SALESFORCE" | undefined
                    form.setValue("type", typeKey ?? "WEB")
                    form.setValue("baseUrl", project.base_url ?? "")
                    setCurrentStep(5)
                })
                .catch(() => {
                    toast.error("Failed to load project for editing")
                })
            return
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // Web App connect
    const [connectLoading, setConnectLoading] = useState(false)
    const [webUsername, setWebUsername] = useState("")
    const [webPassword, setWebPassword] = useState("")
    const [loginStrategy, setLoginStrategy] = useState("form")
    const [showPassword, setShowPassword] = useState(false)
    // Inline error shown below the web app form when validation or API fails
    const [webConnectError, setWebConnectError] = useState<string | null>(null)

    // Web App Metadata Sync Settings
    const [sitemapUrl, setSitemapUrl] = useState("")
    const [maxCrawlPages, setMaxCrawlPages] = useState<number>(30)
    const [keyRoutesRaw, setKeyRoutesRaw] = useState("")
    const [enableDeepCrawl, setEnableDeepCrawl] = useState(false)

    // Salesforce — unified credentials (Connected App + MCP, single form)
    const [sfUsername, setSfUsername] = useState("")
    const [sfPassword, setSfPassword] = useState("")
    const [sfSecurityToken, setSfSecurityToken] = useState("")
    const [sfClientId, setSfClientId] = useState("")
    const [sfClientSecret, setSfClientSecret] = useState("")
    const [sfLoginUrl, setSfLoginUrl] = useState("https://login.salesforce.com")
    const [sfRedirectUri] = useState(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/integrations/salesforce/callback`)
    const [showSfPassword, setShowSfPassword] = useState(false)
    const [showSfToken, setShowSfToken] = useState(false)
    const [showSfSecret, setShowSfSecret] = useState(false)

    // Salesforce connect — per-field errors, API error banner, success state
    const [sfUsernameError, setSfUsernameError] = useState<string | null>(null)
    const [sfPasswordError, setSfPasswordError] = useState<string | null>(null)
    const [sfClientIdError, setSfClientIdError] = useState<string | null>(null)
    const [sfClientSecretError, setSfClientSecretError] = useState<string | null>(null)
    const [sfConnectError, setSfConnectError] = useState<string | null>(null)
    const [sfSuccess, setSfSuccess] = useState<{ oAuth: boolean; mcp: boolean; sync: boolean } | null>(null)

    // API connect
    const [apiKey, setApiKey] = useState("")
    const [bearerToken, setBearerToken] = useState("")

    // Jira Integration
    const [jiraDomain, setJiraDomain] = useState("")
    const [jiraEmail, setJiraEmail] = useState("")
    const [jiraApiToken, setJiraApiToken] = useState("")
    const [jiraConnecting, setJiraConnecting] = useState(false)
    const [jiraConnected, setJiraConnected] = useState(false)
    const [jiraBoards, setJiraBoards] = useState<{id: string; name: string}[]>([])
    const [selectedJiraBoard, setSelectedJiraBoard] = useState("")
    const [selectedJiraBoardName, setSelectedJiraBoardName] = useState("")
    const [jiraSaving, setJiraSaving] = useState(false)
    const [jiraSaved, setJiraSaved] = useState(false)
    const [showJiraToken, setShowJiraToken] = useState(false)

    const form = useForm<z.infer<typeof formSchema>>({
        resolver: zodResolver(formSchema),
        defaultValues: { name: "", description: "", type: "WEB", baseUrl: "" },
    })

    const selectedType = form.watch("type")
    const category = TYPE_TO_CATEGORY[selectedType] || "webapp"

    const onSubmit = async (values: z.infer<typeof formSchema>) => {
        setIsCreating(true)
        try {
            if (isEditMode && editProjectId) {
                // ── EDIT MODE: update the existing project ─────────────────────
                const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${editProjectId}`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        name: values.name,
                        description: values.description || "",
                        type: values.type,
                        category: TYPE_TO_CATEGORY[values.type] || "webapp",
                        base_url: values.baseUrl || "",
                    }),
                })
                if (!response.ok) {
                    const err = await response.json().catch(() => ({}))
                    throw new Error(err.detail || "Failed to update project")
                }
                toast.success("Environment updated! Now connect your application.")
                setCurrentStep(5)
            } else {
                // ── CREATE MODE: create a new project ─────────────────────────
                const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        name: values.name,
                        description: values.description || "",
                        type: values.type,
                        category: TYPE_TO_CATEGORY[values.type] || "webapp",
                        base_url: values.baseUrl || "",
                        status: "Active",
                        tags: [],
                    }),
                })
                if (!response.ok) {
                    const err = await response.json().catch(() => ({}))
                    throw new Error(err.detail || "Failed to create project")
                }
                const data = await response.json()
                setCreatedProjectId(data.id)
                toast.success("Environment created! Now connect your application.")
                setCurrentStep(5)
            }
        } catch (error: any) {
            toast.error(error.message || "Failed to save environment")
        } finally {
            setIsCreating(false)
        }
    }

    const handleConnectWebApp = async () => {
        if (!createdProjectId) return
        setWebConnectError(null)

        const baseUrl = form.getValues("baseUrl")

        // ── Client-side validation ─────────────────────────────────
        const errors: string[] = []
        if (!baseUrl || !baseUrl.trim()) errors.push("Base URL is required to connect your web app.")
        if (loginStrategy !== "none") {
            if (!webUsername.trim()) errors.push("Username / Email is required.")
            if (!webPassword) errors.push("Password is required.")
        }
        if (errors.length > 0) {
            setWebConnectError(errors.join(" "))
            return
        }

        setConnectLoading(true)
        try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${createdProjectId}/connect`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    category: "web_app",
                    base_url: baseUrl,
                    username: webUsername || null,
                    password: webPassword || null,
                    login_strategy: loginStrategy,
                    sitemap_url: sitemapUrl || undefined,
                    max_crawl_pages: maxCrawlPages,
                    key_routes: keyRoutesRaw ? keyRoutesRaw.split('\n').map(r => r.trim()).filter(Boolean) : [],
                    enable_deep_crawl: enableDeepCrawl,
                }),
            })
            if (!response.ok) {
                const err = await response.json().catch(() => ({}))
                setWebConnectError(err.detail || "Connection failed. Please check your credentials and Base URL.")
                return
            }
            toast.success("Web application connected successfully!")
            setTimeout(() => router.push(`/dashboard/projects/${createdProjectId}`), 1000)
        } catch (error: any) {
            setWebConnectError(error.message || "Connection failed. Please try again.")
        } finally {
            setConnectLoading(false)
        }
    }

    // Map backend error codes → human-readable messages
    const SF_ERROR_MESSAGES: Record<string, string> = {
        INVALID_CLIENT: "Invalid Salesforce credentials or Connected App details. Please check and try again.",
        INVALID_CREDENTIALS: "Invalid Salesforce credentials or Connected App details. Please check and try again.",
        CONNECTION_TIMEOUT: "Could not reach Salesforce. Check your instance URL and try again.",
        INVALID_GRANT: "Invalid Salesforce credentials or Connected App details. Please check and try again.",
        VALIDATION_ERROR: "Please fill in all required fields.",
    }

    const handleConnectSalesforce = async () => {
        if (!createdProjectId) return

        // ── Validate all required fields ────────────────────────────────────
        let hasError = false
        if (!sfUsername.trim()) { setSfUsernameError("Username is required"); hasError = true }
        if (!sfPassword.trim()) { setSfPasswordError("Password is required"); hasError = true }
        if (!sfClientId.trim()) { setSfClientIdError("Client ID is required"); hasError = true }
        if (!sfClientSecret.trim()) { setSfClientSecretError("Client Secret is required"); hasError = true }
        if (hasError) return

        setSfConnectError(null)
        setSfSuccess(null)
        setConnectLoading(true)
        try {
            // ── Step 1: Save Connected App credentials ───────────────────────
            const saveRes = await fetch(
                `${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${createdProjectId}/save-sf-credentials`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        client_id: sfClientId,
                        client_secret: sfClientSecret,
                        redirect_uri: sfRedirectUri,
                        login_url: sfLoginUrl,
                        sf_username: sfUsername,
                        sf_password: sfPassword,
                        sf_security_token: sfSecurityToken,
                    }),
                },
            )
            if (!saveRes.ok) {
                const err = await saveRes.json().catch(() => ({}))
                setSfConnectError(
                    SF_ERROR_MESSAGES[err.error ?? ""] ??
                    "Invalid Salesforce credentials or Connected App details. Please check and try again."
                )
                return
            }

            // ── Step 2: OAuth / JSForce registration ─────────────────────────
            const oauthRes = await fetch(
                `${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${createdProjectId}/connect`,
                {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ category: "salesforce" }),
                },
            )
            if (!oauthRes.ok) {
                const err = await oauthRes.json().catch(() => ({}))
                setSfConnectError(
                    SF_ERROR_MESSAGES[err.error ?? ""] ??
                    err.detail ??
                    "Invalid Salesforce credentials or Connected App details. Please check and try again."
                )
                return
            }
            const oauthData = await oauthRes.json()
            if (oauthData.auth_url) {
                toast.info("Redirecting to Salesforce login...")
                window.location.href = oauthData.auth_url
                return
            }

            // ── Step 3: MCP connection using same credentials ─────────────────
            let mcpOk = false
            try {
                const mcpRes = await fetch(
                    `${process.env.NEXT_PUBLIC_API_URL}/api/v1/mcp/projects/${createdProjectId}/mcp-connect`,
                    {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            sf_username: sfUsername,
                            sf_password: sfPassword,
                            sf_security_token: sfSecurityToken,
                            domain: sfLoginUrl.includes("test") ? "test" : "login",
                        }),
                    },
                )
                mcpOk = mcpRes.ok
            } catch { mcpOk = false }

            // ── Show rich success state, auto-navigate after 3 s ─────────────
            setSfSuccess({ oAuth: true, mcp: mcpOk, sync: mcpOk })
            setTimeout(() => router.push(`/dashboard/projects/${createdProjectId}`), 3000)
        } catch {
            setSfConnectError("Invalid Salesforce credentials or Connected App details. Please check and try again.")
        } finally {
            setConnectLoading(false)
        }
    }

    const handleConnectApi = async () => {
        if (!createdProjectId) return
        if (!apiKey && !bearerToken) { toast.error("Provide an API Key or Bearer Token"); return }

        setConnectLoading(true)
        try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${createdProjectId}/connect`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    category: "api",
                    base_url: form.getValues("baseUrl") || null,
                    api_key: apiKey || null,
                    bearer_token: bearerToken || null,
                }),
            })
            if (!response.ok) {
                const err = await response.json().catch(() => ({}))
                throw new Error(err.detail || "Failed to connect")
            }
            toast.success("API integration connected!")
            setTimeout(() => router.push(`/dashboard/projects/${createdProjectId}`), 1000)
        } catch (error: any) {
            toast.error(error.message || "API connection failed")
        } finally {
            setConnectLoading(false)
        }
    }

    const handleJiraConnect = async () => {
        if (!jiraDomain || !jiraEmail || !jiraApiToken) {
            toast.error("Please fill in all Jira connection fields")
            return
        }
        setJiraConnecting(true)
        try {
            // Step 1: Validate credentials
            const connectRes = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/jira/connect`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ domain: jiraDomain, email: jiraEmail, api_token: jiraApiToken }),
            })
            if (!connectRes.ok) {
                const err = await connectRes.json().catch(() => ({}))
                throw new Error(err.detail || "Failed to connect to Jira")
            }

            // Step 2: Fetch boards
            const boardsRes = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/jira/boards`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ domain: jiraDomain, email: jiraEmail, api_token: jiraApiToken }),
            })
            if (!boardsRes.ok) {
                const err = await boardsRes.json().catch(() => ({}))
                throw new Error(err.detail || "Failed to fetch boards")
            }
            const boardsData = await boardsRes.json()
            const boardsList = boardsData.boards || []
            setJiraBoards(boardsList)
            setJiraConnected(true)
            if (boardsList.length > 0) {
                setSelectedJiraBoard(boardsList[0].id)
                setSelectedJiraBoardName(boardsList[0].name)
            }
            toast.success("Connected to Jira successfully!")
        } catch (error: any) {
            toast.error(error.message || "Jira connection failed")
        } finally {
            setJiraConnecting(false)
        }
    }

    const handleSaveJiraConfig = async () => {
        if (!createdProjectId || !selectedJiraBoard) {
            toast.error("Please select a Jira board first")
            return
        }
        setJiraSaving(true)
        try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/jira/projects/${createdProjectId}/config`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    domain: jiraDomain,
                    email: jiraEmail,
                    api_token: jiraApiToken,
                    board_id: selectedJiraBoard,
                    board_name: selectedJiraBoardName,
                }),
            })
            if (!response.ok) {
                const err = await response.json().catch(() => ({}))
                throw new Error(err.detail || "Failed to save Jira config")
            }
            setJiraSaved(true)
            toast.success("Jira configuration saved to environment!")
        } catch (error: any) {
            toast.error(error.message || "Failed to save Jira config")
        } finally {
            setJiraSaving(false)
        }
    }

    const handleSkipConnect = () => {
        toast.info("You can connect later from environment settings.")
        router.push(`/dashboard/projects/${createdProjectId}`)
    }

    const nextStep = async () => {
        // Step 3: manually validate Base URL before triggering Zod
        // (superRefine runs on the full object so we need the type value available)
        if (currentStep === 3) {
            const type = form.getValues("type")
            const baseUrl = form.getValues("baseUrl")
            if (type !== "SALESFORCE") {
                if (!baseUrl || !baseUrl.trim()) {
                    form.setError("baseUrl", { type: "manual", message: "Base URL is required" })
                    return
                }
                if (!/^https?:\/\/.+/.test(baseUrl)) {
                    form.setError("baseUrl", { type: "manual", message: "Must be a valid URL starting with http:// or https://" })
                    return
                }
                form.clearErrors("baseUrl")
            }
            setCurrentStep((prev) => Math.min(prev + 1, steps.length))
            return
        }

        let fieldsToValidate: any[] = []
        if (currentStep === 1) fieldsToValidate = ["name", "description"]
        if (currentStep === 2) fieldsToValidate = ["type"]
        const isValid = await form.trigger(fieldsToValidate)
        if (isValid) setCurrentStep((prev) => Math.min(prev + 1, steps.length))
    }
    const prevStep = () => setCurrentStep((prev) => Math.max(prev - 1, 1))

    const handleConnect = () => {
        if (category === "salesforce") handleConnectSalesforce()
        else if (category === "api") handleConnectApi()
        else handleConnectWebApp()
    }

    const copyToClipboard = (text: string) => {
        navigator.clipboard.writeText(text)
        toast.success("Copied to clipboard")
    }

    return (
        <div className="max-w-3xl mx-auto py-10">
            <div className="mb-8">
                <h1 className="text-3xl font-bold mb-2">
                    {isEditMode ? "Reconnect Environment" : "Create New Environment"}
                </h1>
                <p className="text-muted-foreground">
                    {isEditMode
                        ? "Update your environment details and reconnect your web application."
                        : "Follow the wizard to set up your new testing environment."}
                </p>
            </div>

            {/* Progress Steps */}
            <div className="mb-8 relative flex items-center justify-between">
                <div className="absolute left-0 top-1/2 -z-10 h-0.5 w-full bg-gray-200 dark:bg-gray-800 -translate-y-1/2"></div>
                {steps.map((step) => (
                    <div key={step.id} className="flex flex-col items-center bg-white dark:bg-gray-950 px-2">
                        <div className={`flex h-8 w-8 items-center justify-center rounded-full border-2 text-sm font-bold transition-colors ${currentStep >= step.id ? "border-blue-600 bg-blue-600 text-white" : "border-gray-300 text-gray-500"}`}>
                            {currentStep > step.id ? <Check className="h-4 w-4" /> : step.id}
                        </div>
                        <span className="mt-2 text-xs font-medium text-muted-foreground">{step.name}</span>
                    </div>
                ))}
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>
                        {currentStep === 1 && "Environment Details"}
                        {currentStep === 2 && "Application Type"}
                        {currentStep === 3 && "Configuration"}
                        {currentStep === 4 && "Review & Create"}
                        {currentStep === 5 && "🔗 Connect to Environment"}
                    </CardTitle>
                    <CardDescription>
                        {currentStep === 1 && "Enter the basic information for your environment."}
                        {currentStep === 2 && "Select the type of application you are testing."}
                        {currentStep === 3 && "Configure environment settings."}
                        {currentStep === 4 && "Review your settings before creating."}
                        {currentStep === 5 && "Connect your environment to enable authentication and metadata sync."}
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <Form {...form}>
                        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">

                            {/* Step 1: Basics */}
                            {currentStep === 1 && (
                                <>
                                    <FormField control={form.control} name="name" render={({ field }) => (
                                        <FormItem>
                                            <FormLabel>Environment Name</FormLabel>
                                            <FormControl><Input placeholder="e.g., Customer Portal" {...field} /></FormControl>
                                            <FormMessage />
                                        </FormItem>
                                    )} />
                                    <FormField control={form.control} name="description" render={({ field }) => (
                                        <FormItem>
                                            <FormLabel>Description (Optional)</FormLabel>
                                            <FormControl><Textarea placeholder="Brief description of the environment..." {...field} /></FormControl>
                                            <FormMessage />
                                        </FormItem>
                                    )} />
                                </>
                            )}

                            {/* Step 2: Type */}
                            {currentStep === 2 && (
                                <FormField control={form.control} name="type" render={({ field }) => (
                                    <FormItem className="space-y-3">
                                        <FormLabel>Select Type</FormLabel>
                                        <FormControl>
                                            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                                                {[
                                                    { val: "WEB", icon: Globe, label: "Web Application", desc: "Any web app" },
                                                    { val: "MOBILE", icon: Smartphone, label: "Mobile App", desc: "iOS / Android" },
                                                    { val: "API", icon: Server, label: "API Service", desc: "REST / GraphQL" },
                                                    { val: "SALESFORCE", icon: Cloud, label: "Salesforce", desc: "SF Org + Metadata" },
                                                ].map((option) => (
                                                    <div
                                                        key={option.val}
                                                        className={`cursor-pointer rounded-lg border-2 p-4 flex flex-col items-center gap-2 hover:border-blue-500 transition-all ${field.value === option.val ? "border-blue-600 bg-blue-50 dark:bg-blue-900/20" : "border-gray-200 dark:border-gray-800"}`}
                                                        onClick={() => field.onChange(option.val)}
                                                    >
                                                        <option.icon className={`h-8 w-8 ${field.value === option.val ? "text-blue-600" : "text-muted-foreground"}`} />
                                                        <span className="font-medium text-sm">{option.label}</span>
                                                        <span className="text-[10px] text-muted-foreground">{option.desc}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        </FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )} />
                            )}

                            {/* Step 3: Config */}
                            {currentStep === 3 && (
                                <FormField control={form.control} name="baseUrl" render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>
                                            {selectedType === "SALESFORCE"
                                                ? "Salesforce Instance URL (Optional)"
                                                : <span>Base URL <span className="text-red-500">*</span></span>}
                                        </FormLabel>
                                        <FormControl>
                                            <Input placeholder={selectedType === "SALESFORCE" ? "https://myorg.lightning.force.com" : "https://example.com"} {...field} />
                                        </FormControl>
                                        <CardDescription>
                                            {selectedType === "SALESFORCE"
                                                ? "Will be set automatically during OAuth if left empty."
                                                : "The root URL your tests will run against. e.g. https://app.example.com"}
                                        </CardDescription>
                                        <FormMessage />
                                    </FormItem>
                                )} />
                            )}

                            {/* Step 4: Review */}
                            {currentStep === 4 && (
                                <div className="space-y-4 rounded-lg bg-gray-50 p-4 dark:bg-gray-900 border">
                                    {[
                                        ["Name", form.getValues("name")],
                                        ["Type", form.getValues("type")],
                                        ["Category", category],
                                        ["Base URL", form.getValues("baseUrl") || "N/A"],
                                    ].map(([label, value]) => (
                                        <div key={label} className="flex justify-between border-b pb-2">
                                            <span className="text-muted-foreground">{label}</span>
                                            <span className="font-medium">{value}</span>
                                        </div>
                                    ))}
                                </div>
                            )}

                            {/* Step 5: Connect */}
                            {currentStep === 5 && (
                                <div className="space-y-6">


                                    {/* Web App / Mobile */}
                                    {(category === "webapp") && (
                                        <div className="space-y-4 rounded-lg border-2 border-blue-100 dark:border-blue-900 p-6 bg-blue-50/30 dark:bg-blue-950/10">
                                            <div className="flex items-center gap-2 mb-2">
                                                <Link2 className="h-5 w-5 text-blue-600" />
                                                <h3 className="font-semibold text-blue-700 dark:text-blue-400">Web Application Credentials</h3>
                                            </div>

                                            {/* Inline error banner */}
                                            {webConnectError && (
                                                <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/30 dark:border-red-800 px-4 py-3 text-sm text-red-700 dark:text-red-400">
                                                    <svg className="mt-0.5 h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
                                                    <span>{webConnectError}</span>
                                                </div>
                                            )}

                                            <div className="grid gap-4">
                                                <div>
                                                    <label className="text-sm font-medium mb-1 block">Base URL</label>
                                                    <Input value={form.getValues("baseUrl") || ""} disabled className="bg-gray-100" />
                                                    {!form.getValues("baseUrl") && (
                                                        <p className="text-xs text-red-600 mt-1">⚠ Base URL was not set. Go back to step 3 to enter it.</p>
                                                    )}
                                                </div>
                                                <div>
                                                    <label className="text-sm font-medium mb-1 block">Login Strategy</label>
                                                    <select value={loginStrategy} onChange={(e) => setLoginStrategy(e.target.value)} className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm">
                                                        <option value="form">Form Login</option>
                                                        <option value="basic_auth">Basic Auth</option>
                                                        <option value="sso">SSO (Future)</option>
                                                        <option value="none">No Authentication</option>
                                                    </select>
                                                </div>
                                                {loginStrategy !== "none" && (
                                                    <>
                                                        <div>
                                                            <label className="text-sm font-medium mb-1 block">Username</label>
                                                            <Input placeholder="Enter username or email" value={webUsername} onChange={(e) => setWebUsername(e.target.value)} />
                                                        </div>
                                                        <div>
                                                            <label className="text-sm font-medium mb-1 block">Password</label>
                                                            <div className="relative">
                                                                <Input type={showPassword ? "text" : "password"} placeholder="Enter password" value={webPassword} onChange={(e) => setWebPassword(e.target.value)} />
                                                                <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                                                                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                                                </button>
                                                            </div>
                                                        </div>
                                                    </>
                                                )}
                                            </div>

                                            <div className="mt-8 border-t border-blue-200/50 dark:border-blue-800/50 pt-6">
                                                <div className="flex items-center gap-2 mb-4">
                                                    <Zap className="h-5 w-5 text-blue-600" />
                                                    <h3 className="font-semibold text-blue-700 dark:text-blue-400">Metadata Extractor Settings</h3>
                                                </div>
                                                <div className="grid gap-4">
                                                    <div>
                                                        <label className="text-sm font-medium mb-1 block">Sitemap URL (Optional)</label>
                                                        <Input placeholder="e.g. https://example.com/sitemap.xml (auto-detected if empty)" value={sitemapUrl} onChange={(e) => setSitemapUrl(e.target.value)} />
                                                    </div>
                                                    <div>
                                                        <label className="text-sm font-medium mb-1 block">Max Crawl Pages</label>
                                                        <Input type="number" min={1} max={500} value={maxCrawlPages} onChange={(e) => setMaxCrawlPages(Number(e.target.value))} />
                                                        <p className="text-xs text-muted-foreground mt-1">Limits the number of pages processed (Default: 30).</p>
                                                    </div>
                                                    <div>
                                                        <label className="text-sm font-medium mb-1 block">Key Routes (1 per line)</label>
                                                        <Textarea placeholder="/login&#10;/dashboard&#10;/settings" value={keyRoutesRaw} onChange={(e) => setKeyRoutesRaw(e.target.value)} />
                                                        <p className="text-xs text-muted-foreground mt-1">Paths that MUST be extracted even if not found in the sitemap.</p>
                                                    </div>
                                                    <div className="flex items-center space-x-2 mt-2">
                                                        <input 
                                                            type="checkbox" 
                                                            id="deepCrawl" 
                                                            checked={enableDeepCrawl} 
                                                            onChange={(e) => setEnableDeepCrawl(e.target.checked)}
                                                            className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-600"
                                                        />
                                                        <label htmlFor="deepCrawl" className="text-sm font-medium leading-none">
                                                            Enable Deep UI Crawl (Follow unmapped links)
                                                        </label>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {/* ── Unified Salesforce Connection ──────────────────── */}
                                    {category === "salesforce" && (
                                        <div className="rounded-xl border-2 border-blue-200 dark:border-blue-900 bg-gradient-to-br from-blue-50/60 to-indigo-50/40 dark:from-blue-950/20 dark:to-indigo-950/10 p-6 space-y-5">

                                            {/* Header */}
                                            <div className="flex items-center gap-3">
                                                <div className="p-2 rounded-lg bg-blue-600 text-white">
                                                    <Cloud className="h-5 w-5" />
                                                </div>
                                                <div>
                                                    <h3 className="font-semibold text-gray-900 dark:text-gray-100 text-base">Salesforce Connection</h3>
                                                    <p className="text-xs text-muted-foreground">All credentials are encrypted and stored securely per environment</p>
                                                </div>
                                            </div>

                                            {/* Error banner */}
                                            {sfConnectError && (
                                                <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/30 dark:border-red-800 px-4 py-3 text-sm text-red-700 dark:text-red-400">
                                                    <svg className="mt-0.5 h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" /></svg>
                                                    <span>{sfConnectError}</span>
                                                </div>
                                            )}

                                            {/* Success state */}
                                            {sfSuccess ? (
                                                <div className="rounded-lg border border-green-200 bg-green-50 dark:bg-green-950/30 dark:border-green-800 px-5 py-4 space-y-2">
                                                    <p className="text-sm font-semibold text-green-800 dark:text-green-300 mb-3">Connected successfully — redirecting in a moment…</p>
                                                    <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
                                                        <Check className="h-4 w-4 shrink-0" />
                                                        <span>Connected via Connected App (OAuth)</span>
                                                    </div>
                                                    <div className="flex items-center gap-2 text-sm">
                                                        {sfSuccess.mcp
                                                            ? <Check className="h-4 w-4 shrink-0 text-green-600" />
                                                            : <svg className="h-4 w-4 shrink-0 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>}
                                                        <span className={sfSuccess.mcp ? "text-green-700 dark:text-green-400" : "text-amber-700 dark:text-amber-400"}>
                                                            {sfSuccess.mcp ? "MCP Server connected" : "MCP connection skipped — retry from Integration tab"}
                                                        </span>
                                                    </div>
                                                    <div className="flex items-center gap-2 text-sm">
                                                        {sfSuccess.sync
                                                            ? <Check className="h-4 w-4 shrink-0 text-green-600" />
                                                            : <svg className="h-4 w-4 shrink-0 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><circle cx="12" cy="12" r="10"/></svg>}
                                                        <span className={sfSuccess.sync ? "text-green-700 dark:text-green-400" : "text-muted-foreground"}>
                                                            {sfSuccess.sync ? "Metadata sync started" : "Metadata sync will start after MCP connects"}
                                                        </span>
                                                    </div>
                                                </div>
                                            ) : (
                                                <div className="grid gap-4">

                                                    {/* Username */}
                                                    <div>
                                                        <label className="text-sm font-medium mb-1 block">
                                                            Salesforce Username <span className="text-red-500">*</span>
                                                        </label>
                                                        <Input
                                                            placeholder="e.g. admin@myorg.sandbox"
                                                            value={sfUsername}
                                                            onChange={(e) => { setSfUsername(e.target.value); if (sfUsernameError) setSfUsernameError(null) }}
                                                            autoComplete="off"
                                                            className={sfUsernameError ? "border-red-500 focus-visible:ring-red-500" : ""}
                                                        />
                                                        {sfUsernameError && <p className="text-xs text-red-600 mt-1">{sfUsernameError}</p>}
                                                    </div>

                                                    {/* Password */}
                                                    <div>
                                                        <label className="text-sm font-medium mb-1 block">
                                                            Salesforce Password <span className="text-red-500">*</span>
                                                        </label>
                                                        <div className="relative">
                                                            <Input
                                                                type={showSfPassword ? "text" : "password"}
                                                                placeholder="Your Salesforce password"
                                                                value={sfPassword}
                                                                onChange={(e) => { setSfPassword(e.target.value); if (sfPasswordError) setSfPasswordError(null) }}
                                                                autoComplete="new-password"
                                                                className={sfPasswordError ? "border-red-500 focus-visible:ring-red-500" : ""}
                                                            />
                                                            <button type="button" onClick={() => setShowSfPassword(!showSfPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                                                                {showSfPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                                            </button>
                                                        </div>
                                                        {sfPasswordError && <p className="text-xs text-red-600 mt-1">{sfPasswordError}</p>}
                                                    </div>

                                                    {/* Security Token */}
                                                    <div>
                                                        <label className="text-sm font-medium mb-1 block">Security Token</label>
                                                        <div className="relative">
                                                            <Input
                                                                type={showSfToken ? "text" : "password"}
                                                                placeholder="Your Salesforce security token"
                                                                value={sfSecurityToken}
                                                                onChange={(e) => setSfSecurityToken(e.target.value)}
                                                                autoComplete="new-password"
                                                            />
                                                            <button type="button" onClick={() => setShowSfToken(!showSfToken)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                                                                {showSfToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                                            </button>
                                                        </div>
                                                        <p className="text-xs text-muted-foreground mt-1">
                                                            Find it in Salesforce → Settings → My Personal Information → Reset My Security Token
                                                        </p>
                                                    </div>

                                                    <hr className="border-border" />

                                                    {/* Client ID */}
                                                    <div>
                                                        <label className="text-sm font-medium mb-1 block">
                                                            Connected App Client ID <span className="text-red-500">*</span>
                                                        </label>
                                                        <Input
                                                            placeholder="Enter Consumer Key from Connected App"
                                                            value={sfClientId}
                                                            onChange={(e) => { setSfClientId(e.target.value); if (sfClientIdError) setSfClientIdError(null) }}
                                                            autoComplete="off"
                                                            className={sfClientIdError ? "border-red-500 focus-visible:ring-red-500" : ""}
                                                        />
                                                        {sfClientIdError && <p className="text-xs text-red-600 mt-1">{sfClientIdError}</p>}
                                                    </div>

                                                    {/* Client Secret */}
                                                    <div>
                                                        <label className="text-sm font-medium mb-1 block">
                                                            Connected App Client Secret <span className="text-red-500">*</span>
                                                        </label>
                                                        <div className="relative">
                                                            <Input
                                                                type={showSfSecret ? "text" : "password"}
                                                                placeholder="Enter Consumer Secret"
                                                                value={sfClientSecret}
                                                                onChange={(e) => { setSfClientSecret(e.target.value); if (sfClientSecretError) setSfClientSecretError(null) }}
                                                                autoComplete="new-password"
                                                                className={sfClientSecretError ? "border-red-500 focus-visible:ring-red-500" : ""}
                                                            />
                                                            <button type="button" onClick={() => setShowSfSecret(!showSfSecret)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                                                                {showSfSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                                            </button>
                                                        </div>
                                                        {sfClientSecretError && <p className="text-xs text-red-600 mt-1">{sfClientSecretError}</p>}
                                                    </div>

                                                    {/* Callback URL */}
                                                    <div>
                                                        <label className="text-sm font-medium mb-1 block">Callback URL</label>
                                                        <div className="flex gap-2">
                                                            <Input value={sfRedirectUri} readOnly className="font-mono text-xs bg-muted" />
                                                            <Button type="button" variant="outline" size="icon" onClick={() => copyToClipboard(sfRedirectUri)}>
                                                                <Copy className="h-4 w-4" />
                                                            </Button>
                                                        </div>
                                                        <p className="text-xs text-muted-foreground mt-1">Copy this URL into your Salesforce Connected App settings.</p>
                                                    </div>

                                                    {/* Login URL */}
                                                    <div>
                                                        <label className="text-sm font-medium mb-1 block">Login URL</label>
                                                        <select
                                                            value={sfLoginUrl}
                                                            onChange={(e) => setSfLoginUrl(e.target.value)}
                                                            className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
                                                        >
                                                            <option value="https://login.salesforce.com">Production (login.salesforce.com)</option>
                                                            <option value="https://test.salesforce.com">Sandbox (test.salesforce.com)</option>
                                                        </select>
                                                    </div>

                                                    {/* Primary connect button — inside the panel */}
                                                    <Button
                                                        type="button"
                                                        onClick={handleConnectSalesforce}
                                                        disabled={connectLoading}
                                                        className="w-full h-11 text-base font-semibold bg-blue-600 hover:bg-blue-700 mt-1"
                                                    >
                                                        {connectLoading
                                                            ? <><Loader2 className="mr-2 h-5 w-5 animate-spin" />Connecting…</>
                                                            : <><Zap className="mr-2 h-5 w-5" />Connect to Salesforce</>}
                                                    </Button>
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    {/* API */}
                                    {category === "api" && (
                                        <div className="space-y-4 rounded-lg border-2 border-green-100 dark:border-green-900 p-6 bg-green-50/30 dark:bg-green-950/10">
                                            <div className="flex items-center gap-2 mb-2">
                                                <Key className="h-5 w-5 text-green-600" />
                                                <h3 className="font-semibold text-green-700 dark:text-green-400">API Authentication</h3>
                                            </div>
                                            <div className="grid gap-4">
                                                <div>
                                                    <label className="text-sm font-medium mb-1 block">Base URL</label>
                                                    <Input value={form.getValues("baseUrl") || ""} disabled className="bg-gray-100" />
                                                </div>
                                                <div>
                                                    <label className="text-sm font-medium mb-1 block">API Key</label>
                                                    <Input type="password" placeholder="Enter API key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
                                                </div>
                                                <div>
                                                    <label className="text-sm font-medium mb-1 block">Bearer Token (alternative)</label>
                                                    <Input type="password" placeholder="Enter bearer token" value={bearerToken} onChange={(e) => setBearerToken(e.target.value)} />
                                                </div>
                                            </div>
                                        </div>
                                    )}

                                    {/* ── Jira Integration (available for all project types) ── */}
                                    <div className="space-y-4 rounded-lg border-2 border-purple-100 dark:border-purple-900 p-6 bg-purple-50/30 dark:bg-purple-950/10 mt-6">
                                        <div className="flex items-center gap-2 mb-2">
                                            <svg className="h-5 w-5 text-purple-600" viewBox="0 0 24 24" fill="currentColor">
                                                <path d="M11.53 2c0 2.4 1.97 4.35 4.35 4.35h1.78v1.7c0 2.4 1.94 4.34 4.34 4.35V2.84a.84.84 0 0 0-.84-.84H11.53zM6.77 6.8a4.36 4.36 0 0 0 4.34 4.34h1.8v1.72a4.36 4.36 0 0 0 4.34 4.34V7.63a.84.84 0 0 0-.83-.83H6.77zM2 11.6a4.35 4.35 0 0 0 4.34 4.34h1.8v1.72A4.35 4.35 0 0 0 12.48 22v-9.57a.84.84 0 0 0-.84-.84H2z" />
                                            </svg>
                                            <h3 className="font-semibold text-purple-700 dark:text-purple-400">Jira Integration (Optional)</h3>
                                        </div>
                                        <p className="text-sm text-muted-foreground mb-3">
                                            Connect your Jira account to import user stories when creating test cases.
                                        </p>

                                        {jiraSaved ? (
                                            <div className="flex items-center gap-2 p-3 bg-green-50 dark:bg-green-950/20 border border-green-200 dark:border-green-800 rounded-md">
                                                <Check className="h-4 w-4 text-green-600" />
                                                <span className="text-sm text-green-700 dark:text-green-400 font-medium">
                                                    Jira configured — Board: {selectedJiraBoardName}
                                                </span>
                                            </div>
                                        ) : !jiraConnected ? (
                                            <div className="grid gap-4">
                                                <div>
                                                    <label className="text-sm font-medium mb-1 block">Jira Domain</label>
                                                    <Input
                                                        placeholder="https://yourcompany.atlassian.net"
                                                        value={jiraDomain}
                                                        onChange={(e) => setJiraDomain(e.target.value)}
                                                    />
                                                </div>
                                                <div>
                                                    <label className="text-sm font-medium mb-1 block">Email</label>
                                                    <Input
                                                        type="email"
                                                        placeholder="you@company.com"
                                                        value={jiraEmail}
                                                        onChange={(e) => setJiraEmail(e.target.value)}
                                                    />
                                                </div>
                                                <div>
                                                    <label className="text-sm font-medium mb-1 block">API Token</label>
                                                    <div className="relative">
                                                        <Input
                                                            type={showJiraToken ? "text" : "password"}
                                                            placeholder="Enter your Jira API token"
                                                            value={jiraApiToken}
                                                            onChange={(e) => setJiraApiToken(e.target.value)}
                                                        />
                                                        <button type="button" onClick={() => setShowJiraToken(!showJiraToken)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                                                            {showJiraToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                                        </button>
                                                    </div>
                                                    <p className="text-xs text-muted-foreground mt-1">
                                                        Generate at <a href="https://id.atlassian.com/manage-profile/security/api-tokens" target="_blank" rel="noreferrer" className="text-purple-600 hover:underline">Atlassian API Tokens</a>
                                                    </p>
                                                </div>
                                                <Button
                                                    type="button"
                                                    variant="outline"
                                                    onClick={handleJiraConnect}
                                                    disabled={jiraConnecting || !jiraDomain || !jiraEmail || !jiraApiToken}
                                                    className="w-fit border-purple-300 text-purple-700 hover:bg-purple-100"
                                                >
                                                    {jiraConnecting ? (
                                                        <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Connecting...</>
                                                    ) : (
                                                        <><Link2 className="mr-2 h-4 w-4" />Connect & Fetch Boards</>
                                                    )}
                                                </Button>
                                            </div>
                                        ) : (
                                            <div className="grid gap-4">
                                                <div className="flex items-center gap-2">
                                                    <Check className="h-4 w-4 text-green-600" />
                                                    <span className="text-sm text-green-700 dark:text-green-400 font-medium">Connected to Jira</span>
                                                </div>
                                                <div>
                                                    <label className="text-sm font-medium mb-1 block">Select Jira Board</label>
                                                    <select
                                                        value={selectedJiraBoard}
                                                        onChange={(e) => {
                                                            setSelectedJiraBoard(e.target.value)
                                                            const board = jiraBoards.find(b => b.id === e.target.value)
                                                            setSelectedJiraBoardName(board?.name || "")
                                                        }}
                                                        className="w-full h-9 rounded-md border border-purple-200 dark:border-purple-800 bg-white/50 dark:bg-black/20 px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-2 focus:ring-purple-400 cursor-pointer"
                                                    >
                                                        {jiraBoards.map((board) => (
                                                            <option key={board.id} value={board.id}>{board.name}</option>
                                                        ))}
                                                    </select>
                                                </div>
                                                <Button
                                                    type="button"
                                                    onClick={handleSaveJiraConfig}
                                                    disabled={jiraSaving || !selectedJiraBoard}
                                                    className="w-fit bg-purple-600 hover:bg-purple-700"
                                                >
                                                    {jiraSaving ? (
                                                        <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Saving...</>
                                                    ) : (
                                                        <><Check className="mr-2 h-4 w-4" />Save Jira Configuration</>
                                                    )}
                                                </Button>
                                            </div>
                                        )}
                                    </div>
                                </div>
                            )}

                        </form>
                    </Form>
                </CardContent>
                <CardFooter className="flex justify-between">
                    {currentStep < 5 && (
                        <Button variant="outline" onClick={prevStep} disabled={currentStep === 1}>
                            <ChevronLeft className="mr-2 h-4 w-4" /> Back
                        </Button>
                    )}
                    {currentStep < 4 && (
                        <Button onClick={nextStep}>
                            Next <ChevronRight className="ml-2 h-4 w-4" />
                        </Button>
                    )}
                    {currentStep === 4 && (
                        <Button onClick={form.handleSubmit(onSubmit)} disabled={isCreating} className="bg-green-600 hover:bg-green-700">
                            {isCreating
                                ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" />{isEditMode ? "Updating..." : "Creating..."}</> )
                                : (<>{isEditMode ? "Update Environment" : "Create Environment"} <ChevronRight className="ml-2 h-4 w-4" /></>)}
                        </Button>
                    )}
                    {currentStep === 5 && (
                        <div className="flex w-full justify-between">
                            <Button variant="ghost" onClick={handleSkipConnect}>
                                {sfSuccess ? "Continue to Environment" : "Skip for Now"}
                            </Button>
                            {/* Salesforce has its own "Connect to Salesforce" button inside the form panel */}
                            {category !== "salesforce" && (
                                <Button
                                    onClick={handleConnect}
                                    disabled={connectLoading}
                                    className={category === "api" ? "bg-green-600 hover:bg-green-700" : "bg-blue-600 hover:bg-blue-700"}
                                >
                                    {connectLoading ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" />Connecting...</>) : (
                                        <>
                                            {category === "api" && <><Key className="mr-2 h-4 w-4" />Save API Credentials</>}
                                            {category === "webapp" && <><Link2 className="mr-2 h-4 w-4" />Connect</>}
                                        </>
                                    )}
                                </Button>
                            )}
                        </div>
                    )}
                </CardFooter>
            </Card>
        </div>
    )
}
