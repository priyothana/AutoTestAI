"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import * as z from "zod"
import {
    Check, Globe, Smartphone, Server, ChevronRight, ChevronLeft,
    Cloud, Link2, Loader2, Eye, EyeOff, ExternalLink, Key, Copy
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
    baseUrl: z.string().url("Must be a valid URL").optional().or(z.literal("")),
})

export default function CreateProjectPage() {
    const router = useRouter()
    const [currentStep, setCurrentStep] = useState(1)
    const [createdProjectId, setCreatedProjectId] = useState<string | null>(null)
    const [isCreating, setIsCreating] = useState(false)

    // Web App connect
    const [connectLoading, setConnectLoading] = useState(false)
    const [webUsername, setWebUsername] = useState("")
    const [webPassword, setWebPassword] = useState("")
    const [loginStrategy, setLoginStrategy] = useState("form")
    const [showPassword, setShowPassword] = useState(false)

    // Salesforce Connected App creds
    const [sfClientId, setSfClientId] = useState("")
    const [sfClientSecret, setSfClientSecret] = useState("")
    const [sfLoginUrl, setSfLoginUrl] = useState("https://login.salesforce.com")
    const [sfRedirectUri, setSfRedirectUri] = useState("http://localhost:8000/api/v1/integrations/salesforce/callback")
    const [showSfSecret, setShowSfSecret] = useState(false)

    // API connect
    const [apiKey, setApiKey] = useState("")
    const [bearerToken, setBearerToken] = useState("")

    const form = useForm<z.infer<typeof formSchema>>({
        resolver: zodResolver(formSchema),
        defaultValues: { name: "", description: "", type: "WEB", baseUrl: "" },
    })

    const selectedType = form.watch("type")
    const category = TYPE_TO_CATEGORY[selectedType] || "webapp"

    const onSubmit = async (values: z.infer<typeof formSchema>) => {
        setIsCreating(true)
        try {
            const response = await fetch("http://localhost:8000/api/v1/projects/", {
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
            toast.success("Project created! Now connect your application.")
            setCurrentStep(5)
        } catch (error: any) {
            toast.error(error.message || "Failed to create project")
        } finally {
            setIsCreating(false)
        }
    }

    const handleConnectWebApp = async () => {
        if (!createdProjectId) return
        const baseUrl = form.getValues("baseUrl")
        if (!baseUrl) { toast.error("Base URL is required"); return }

        setConnectLoading(true)
        try {
            const response = await fetch(`http://localhost:8000/api/v1/projects/${createdProjectId}/connect`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    category: "web_app",
                    base_url: baseUrl,
                    username: webUsername || null,
                    password: webPassword || null,
                    login_strategy: loginStrategy,
                }),
            })
            if (!response.ok) {
                const err = await response.json().catch(() => ({}))
                throw new Error(err.detail || "Failed to connect")
            }
            toast.success("Web application connected successfully!")
            setTimeout(() => router.push(`/dashboard/projects/${createdProjectId}`), 1000)
        } catch (error: any) {
            toast.error(error.message || "Connection failed")
        } finally {
            setConnectLoading(false)
        }
    }

    const handleConnectSalesforce = async () => {
        if (!createdProjectId) return
        if (!sfClientId || !sfClientSecret) {
            toast.error("Connected App Client ID and Secret are required")
            return
        }

        setConnectLoading(true)
        try {
            // Step 1: Save Connected App credentials
            const saveRes = await fetch(`http://localhost:8000/api/v1/projects/${createdProjectId}/save-sf-credentials`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    client_id: sfClientId,
                    client_secret: sfClientSecret,
                    redirect_uri: sfRedirectUri,
                    login_url: sfLoginUrl,
                }),
            })
            if (!saveRes.ok) {
                const err = await saveRes.json().catch(() => ({}))
                throw new Error(err.detail || "Failed to save credentials")
            }

            // Step 2: Start OAuth flow
            const oauthRes = await fetch(`http://localhost:8000/api/v1/projects/${createdProjectId}/connect`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ category: "salesforce" }),
            })
            if (!oauthRes.ok) {
                const err = await oauthRes.json().catch(() => ({}))
                throw new Error(err.detail || "Failed to initiate OAuth")
            }
            const data = await oauthRes.json()
            if (data.auth_url) {
                toast.info("Redirecting to Salesforce login...")
                window.location.href = data.auth_url
            }
        } catch (error: any) {
            toast.error(error.message || "Salesforce connection failed")
        } finally {
            setConnectLoading(false)
        }
    }

    const handleConnectApi = async () => {
        if (!createdProjectId) return
        if (!apiKey && !bearerToken) { toast.error("Provide an API Key or Bearer Token"); return }

        setConnectLoading(true)
        try {
            const response = await fetch(`http://localhost:8000/api/v1/projects/${createdProjectId}/connect`, {
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

    const handleSkipConnect = () => {
        toast.info("You can connect later from project settings.")
        router.push(`/dashboard/projects/${createdProjectId}`)
    }

    const nextStep = async () => {
        let fieldsToValidate: any[] = []
        if (currentStep === 1) fieldsToValidate = ["name", "description"]
        if (currentStep === 2) fieldsToValidate = ["type"]
        if (currentStep === 3) fieldsToValidate = ["baseUrl"]
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
                <h1 className="text-3xl font-bold mb-2">Create New Project</h1>
                <p className="text-muted-foreground">Follow the wizard to set up your new testing project.</p>
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
                        {currentStep === 1 && "Project Details"}
                        {currentStep === 2 && "Application Type"}
                        {currentStep === 3 && "Configuration"}
                        {currentStep === 4 && "Review & Create"}
                        {currentStep === 5 && "🔗 Connect to Project"}
                    </CardTitle>
                    <CardDescription>
                        {currentStep === 1 && "Enter the basic information for your project."}
                        {currentStep === 2 && "Select the type of application you are testing."}
                        {currentStep === 3 && "Configure environment settings."}
                        {currentStep === 4 && "Review your settings before creating."}
                        {currentStep === 5 && "Connect your project to enable authentication and metadata sync."}
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
                                            <FormLabel>Project Name</FormLabel>
                                            <FormControl><Input placeholder="e.g., Customer Portal" {...field} /></FormControl>
                                            <FormMessage />
                                        </FormItem>
                                    )} />
                                    <FormField control={form.control} name="description" render={({ field }) => (
                                        <FormItem>
                                            <FormLabel>Description (Optional)</FormLabel>
                                            <FormControl><Textarea placeholder="Brief description of the project..." {...field} /></FormControl>
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
                                            {selectedType === "SALESFORCE" ? "Salesforce Instance URL (Optional)" : "Base URL (Optional)"}
                                        </FormLabel>
                                        <FormControl>
                                            <Input placeholder={selectedType === "SALESFORCE" ? "https://myorg.lightning.force.com" : "https://example.com"} {...field} />
                                        </FormControl>
                                        <CardDescription>
                                            {selectedType === "SALESFORCE" ? "Will be set automatically during OAuth if left empty." : "The default URL for your tests to run against."}
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
                                            <div className="grid gap-4">
                                                <div>
                                                    <label className="text-sm font-medium mb-1 block">Base URL</label>
                                                    <Input value={form.getValues("baseUrl") || ""} disabled className="bg-gray-100" />
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
                                        </div>
                                    )}

                                    {/* Salesforce */}
                                    {category === "salesforce" && (
                                        <div className="space-y-4 rounded-lg border-2 border-purple-100 dark:border-purple-900 p-6 bg-purple-50/30 dark:bg-purple-950/10">
                                            <div className="flex items-center gap-2 mb-2">
                                                <Cloud className="h-5 w-5 text-purple-600" />
                                                <h3 className="font-semibold text-purple-700 dark:text-purple-400">Salesforce Connected App</h3>
                                            </div>
                                            <p className="text-sm text-muted-foreground mb-3">
                                                Enter your Salesforce Connected App details. These are encrypted and stored securely.
                                            </p>
                                            <div className="grid gap-4">
                                                <div>
                                                    <label className="text-sm font-medium mb-1 block">Connected App Client ID <span className="text-red-500">*</span></label>
                                                    <Input placeholder="3MVG9..." value={sfClientId} onChange={(e) => setSfClientId(e.target.value)} />
                                                </div>
                                                <div>
                                                    <label className="text-sm font-medium mb-1 block">Connected App Client Secret <span className="text-red-500">*</span></label>
                                                    <div className="relative">
                                                        <Input type={showSfSecret ? "text" : "password"} placeholder="Enter client secret" value={sfClientSecret} onChange={(e) => setSfClientSecret(e.target.value)} />
                                                        <button type="button" onClick={() => setShowSfSecret(!showSfSecret)} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                                                            {showSfSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                                        </button>
                                                    </div>
                                                </div>
                                                <div>
                                                    <label className="text-sm font-medium mb-1 block">Callback URL</label>
                                                    <div className="flex gap-2">
                                                        <Input value={sfRedirectUri} onChange={(e) => setSfRedirectUri(e.target.value)} className="font-mono text-xs" />
                                                        <Button type="button" variant="outline" size="icon" onClick={() => copyToClipboard(sfRedirectUri)}>
                                                            <Copy className="h-4 w-4" />
                                                        </Button>
                                                    </div>
                                                    <p className="text-xs text-muted-foreground mt-1">Copy this URL into your Salesforce Connected App settings.</p>
                                                </div>
                                                <div>
                                                    <label className="text-sm font-medium mb-1 block">Login URL</label>
                                                    <select value={sfLoginUrl} onChange={(e) => setSfLoginUrl(e.target.value)} className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm">
                                                        <option value="https://login.salesforce.com">Production (login.salesforce.com)</option>
                                                        <option value="https://test.salesforce.com">Sandbox (test.salesforce.com)</option>
                                                    </select>
                                                </div>
                                            </div>
                                            <div className="bg-white/60 dark:bg-black/20 rounded-md p-3 text-sm space-y-1 border mt-2">
                                                <div className="flex items-center gap-2 text-green-600"><Check className="h-3.5 w-3.5" /> Per-project credentials — isolated per org</div>
                                                <div className="flex items-center gap-2 text-green-600"><Check className="h-3.5 w-3.5" /> Encrypted at rest with Fernet</div>
                                                <div className="flex items-center gap-2 text-green-600"><Check className="h-3.5 w-3.5" /> Auto metadata sync after OAuth</div>
                                            </div>
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
                            {isCreating ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" />Creating...</>) : (<>Create Project <ChevronRight className="ml-2 h-4 w-4" /></>)}
                        </Button>
                    )}
                    {currentStep === 5 && (
                        <div className="flex w-full justify-between">
                            <Button variant="ghost" onClick={handleSkipConnect}>Skip for Now</Button>
                            <Button
                                onClick={handleConnect}
                                disabled={connectLoading}
                                className={category === "salesforce" ? "bg-purple-600 hover:bg-purple-700" : category === "api" ? "bg-green-600 hover:bg-green-700" : "bg-blue-600 hover:bg-blue-700"}
                            >
                                {connectLoading ? (<><Loader2 className="mr-2 h-4 w-4 animate-spin" />Connecting...</>) : (
                                    <>
                                        {category === "salesforce" && <><ExternalLink className="mr-2 h-4 w-4" />Connect with Salesforce</>}
                                        {category === "api" && <><Key className="mr-2 h-4 w-4" />Save API Credentials</>}
                                        {category === "webapp" && <><Link2 className="mr-2 h-4 w-4" />Connect</>}
                                    </>
                                )}
                            </Button>
                        </div>
                    )}
                </CardFooter>
            </Card>
        </div>
    )
}
