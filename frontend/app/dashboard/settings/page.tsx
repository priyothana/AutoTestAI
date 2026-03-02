"use client"

import { useState, useEffect } from "react"
import { Loader2, Save, CheckCircle2, AlertCircle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"

export default function SettingsPage() {
    const [isLoading, setIsLoading] = useState(true)
    const [isSaving, setIsSaving] = useState(false)
    const [statusMessage, setStatusMessage] = useState<{ type: 'success' | 'error', text: string } | null>(null)

    const [settings, setSettings] = useState({
        // General
        default_timeout: 30000,
        parallel_execution: false,
        retry_count: 0,
        screenshot_mode: "on-failure",

        // Environment
        base_url: "",
        browser: "chromium",
        device: "desktop",
        variables: "{}",

        // Integrations
        slack_webhook: "",
        email_notifications: false,
        webhook_callback: ""
    })

    useEffect(() => {
        fetchSettings()
    }, [])

    const fetchSettings = async () => {
        setIsLoading(true)
        try {
            const response = await fetch("http://localhost:8000/api/v1/settings/")
            if (response.ok) {
                const data = await response.json()
                setSettings({
                    default_timeout: data.default_timeout,
                    parallel_execution: data.parallel_execution,
                    retry_count: data.retry_count,
                    screenshot_mode: data.screenshot_mode,
                    base_url: data.base_url || "",
                    browser: data.browser,
                    device: data.device,
                    variables: typeof data.variables === 'string' ? data.variables : JSON.stringify(data.variables, null, 2),
                    slack_webhook: data.slack_webhook || "",
                    email_notifications: data.email_notifications,
                    webhook_callback: data.webhook_callback || ""
                })
            }
        } catch (error) {
            console.error("Failed to fetch settings:", error)
        } finally {
            setIsLoading(false)
        }
    }

    const handleSave = async () => {
        setIsSaving(true)
        setStatusMessage(null)

        try {
            // Parse variables back to JSON if it's a valid string
            let parsedVariables = {}
            try {
                parsedVariables = JSON.parse(settings.variables || "{}")
            } catch (e) {
                throw new Error("Invalid JSON in Environment Variables")
            }

            const payload = {
                ...settings,
                variables: parsedVariables
            }

            const response = await fetch("http://localhost:8000/api/v1/settings/", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            })

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.detail || "Failed to save settings")
            }

            setStatusMessage({ type: 'success', text: "Settings saved successfully!" })

            // Clear success message after 3 seconds
            setTimeout(() => setStatusMessage(null), 3000)
        } catch (error: any) {
            setStatusMessage({ type: 'error', text: error.message || "An error occurred while saving." })
        } finally {
            setIsSaving(false)
        }
    }

    const handleChange = (field: string, value: any) => {
        setSettings(prev => ({ ...prev, [field]: value }))
    }

    if (isLoading) {
        return (
            <div className="flex h-[50vh] items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
        )
    }

    return (
        <div className="space-y-6 max-w-5xl">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight">Settings</h2>
                    <p className="text-muted-foreground">Manage your application configuration and preferences.</p>
                </div>
                <div className="flex items-center gap-4">
                    {statusMessage && (
                        <div className={`flex items-center gap-2 text-sm px-3 py-1.5 rounded-md ${statusMessage.type === 'success' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                            }`}>
                            {statusMessage.type === 'success' ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
                            {statusMessage.text}
                        </div>
                    )}
                    <Button onClick={handleSave} disabled={isSaving}>
                        {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                        Save Changes
                    </Button>
                </div>
            </div>

            <Tabs defaultValue="general" className="w-full">
                <TabsList className="grid w-full md:w-[400px] grid-cols-3">
                    <TabsTrigger value="general">General</TabsTrigger>
                    <TabsTrigger value="environment">Environment</TabsTrigger>
                    <TabsTrigger value="integrations">Integrations</TabsTrigger>
                </TabsList>

                <TabsContent value="general" className="mt-6 space-y-6">
                    <Card>
                        <CardHeader>
                            <CardTitle>Execution Preferences</CardTitle>
                            <CardDescription>Configure how tests are run by default.</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-6">
                            <div className="grid gap-4 sm:grid-cols-2">
                                <div className="space-y-2">
                                    <Label htmlFor="timeout">Default Timeout (ms)</Label>
                                    <Input
                                        id="timeout"
                                        type="number"
                                        value={settings.default_timeout}
                                        onChange={(e) => handleChange('default_timeout', parseInt(e.target.value) || 0)}
                                    />
                                    <p className="text-xs text-muted-foreground">Maximum time a step can take before failing.</p>
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="retries">Retry Count</Label>
                                    <Input
                                        id="retries"
                                        type="number"
                                        min="0"
                                        max="5"
                                        value={settings.retry_count}
                                        onChange={(e) => handleChange('retry_count', parseInt(e.target.value) || 0)}
                                    />
                                    <p className="text-xs text-muted-foreground">Number of times to retry a failed test.</p>
                                </div>
                            </div>

                            <div className="grid gap-4 sm:grid-cols-2">
                                <div className="space-y-2">
                                    <Label htmlFor="screenshot">Screenshot Mode</Label>
                                    <Select value={settings.screenshot_mode} onValueChange={(val) => handleChange('screenshot_mode', val)}>
                                        <SelectTrigger id="screenshot">
                                            <SelectValue placeholder="Select mode" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="off">Off</SelectItem>
                                            <SelectItem value="on-failure">On Failure</SelectItem>
                                            <SelectItem value="always">Always</SelectItem>
                                        </SelectContent>
                                    </Select>
                                    <p className="text-xs text-muted-foreground">When to capture screenshots during execution.</p>
                                </div>
                                <div className="flex items-center justify-between rounded-lg border p-4 shadow-sm h-full max-h-[72px] mt-auto">
                                    <div className="space-y-0.5">
                                        <Label className="text-base">Parallel Execution</Label>
                                        <p className="text-xs text-muted-foreground">Run tests concurrently.</p>
                                    </div>
                                    <Switch
                                        checked={settings.parallel_execution}
                                        onCheckedChange={(val) => handleChange('parallel_execution', val)}
                                    />
                                </div>
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="environment" className="mt-6 space-y-6">
                    <Card>
                        <CardHeader>
                            <CardTitle>Test Environment</CardTitle>
                            <CardDescription>Set the default targeting parameters for test runs.</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-6">
                            <div className="space-y-2">
                                <Label htmlFor="base_url">Base URL</Label>
                                <Input
                                    id="base_url"
                                    placeholder="https://example.com"
                                    value={settings.base_url}
                                    onChange={(e) => handleChange('base_url', e.target.value)}
                                />
                                <p className="text-xs text-muted-foreground">The default starting URL for web tests.</p>
                            </div>

                            <div className="grid gap-4 sm:grid-cols-2">
                                <div className="space-y-2">
                                    <Label htmlFor="browser">Default Browser</Label>
                                    <Select value={settings.browser} onValueChange={(val) => handleChange('browser', val)}>
                                        <SelectTrigger id="browser">
                                            <SelectValue placeholder="Select browser" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="chromium">Chromium (Chrome/Edge)</SelectItem>
                                            <SelectItem value="firefox">Firefox</SelectItem>
                                            <SelectItem value="webkit">WebKit (Safari)</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                                <div className="space-y-2">
                                    <Label htmlFor="device">Emulated Device</Label>
                                    <Select value={settings.device} onValueChange={(val) => handleChange('device', val)}>
                                        <SelectTrigger id="device">
                                            <SelectValue placeholder="Select device" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="desktop">Desktop</SelectItem>
                                            <SelectItem value="mobile-ios">Mobile (iOS)</SelectItem>
                                            <SelectItem value="mobile-android">Mobile (Android)</SelectItem>
                                            <SelectItem value="tablet">Tablet</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="variables">Environment Variables (JSON)</Label>
                                <Textarea
                                    id="variables"
                                    className="font-mono text-sm min-h-[150px]"
                                    placeholder='{ "USERNAME": "tester", "PASSWORD": "password123" }'
                                    value={settings.variables}
                                    onChange={(e) => handleChange('variables', e.target.value)}
                                />
                                <p className="text-xs text-muted-foreground">These variables will be accessible during test execution.</p>
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>

                <TabsContent value="integrations" className="mt-6 space-y-6">
                    <Card>
                        <CardHeader>
                            <CardTitle>External Integrations</CardTitle>
                            <CardDescription>Connect AutoTest AI to your existing tools.</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-6">
                            <div className="space-y-2">
                                <Label htmlFor="slack">Slack Webhook URL</Label>
                                <Input
                                    id="slack"
                                    type="url"
                                    placeholder="https://hooks.slack.com/services/..."
                                    value={settings.slack_webhook}
                                    onChange={(e) => handleChange('slack_webhook', e.target.value)}
                                />
                                <p className="text-xs text-muted-foreground">Receive test execution summaries in a Slack channel.</p>
                            </div>

                            <div className="space-y-2">
                                <Label htmlFor="webhook_callback">Custom Webhook Callback</Label>
                                <Input
                                    id="webhook_callback"
                                    type="url"
                                    placeholder="https://your-ci.com/api/test-results"
                                    value={settings.webhook_callback}
                                    onChange={(e) => handleChange('webhook_callback', e.target.value)}
                                />
                                <p className="text-xs text-muted-foreground">Hit this URL when a test run completes.</p>
                            </div>

                            <div className="flex items-center justify-between rounded-lg border p-4 shadow-sm">
                                <div className="space-y-0.5">
                                    <Label className="text-base">Email Notifications</Label>
                                    <p className="text-xs text-muted-foreground">Send an email when a test fails.</p>
                                </div>
                                <Switch
                                    checked={settings.email_notifications}
                                    onCheckedChange={(val) => handleChange('email_notifications', val)}
                                />
                            </div>
                        </CardContent>
                    </Card>
                </TabsContent>
            </Tabs>
        </div>
    )
}
