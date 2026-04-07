"use client"

import { useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Loader2, ChevronDown, ChevronRight, KeyRound } from "lucide-react"
import { toast } from "sonner"

interface CreateProjectModalProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    onSuccess: () => void
}

export function CreateProjectModal({ open, onOpenChange, onSuccess }: CreateProjectModalProps) {
    const [isLoading, setIsLoading] = useState(false)
    const [showCredentials, setShowCredentials] = useState(false)
    const [formData, setFormData] = useState({
        name: "",
        description: "",
        type: "WEB",
        base_url: "",
        status: "Active",
        tags: "",
        login_username: "",
        login_password: "",
        login_url: "",
    })

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault()
        setIsLoading(true)

        try {
            const payload: any = {
                name: formData.name,
                description: formData.description,
                type: formData.type,
                base_url: formData.base_url,
                status: formData.status,
                tags: formData.tags.split(",").map(t => t.trim()).filter(Boolean),
            }

            // Include login credentials if provided (Web projects)
            if (formData.login_username || formData.login_password) {
                payload.login_username = formData.login_username
                payload.login_password = formData.login_password
                payload.login_url = formData.login_url || formData.base_url
                payload.login_strategy = "form"
            }

            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"}/api/v1/projects/`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(payload),
            })

            if (!response.ok) {
                const error = await response.json()
                throw new Error(error.detail || "Failed to create project")
            }

            toast.success("Environment created successfully! Credentials saved securely.")
            onOpenChange(false)
            onSuccess()

            // Reset form
            setFormData({
                name: "",
                description: "",
                type: "WEB",
                base_url: "",
                status: "Active",
                tags: "",
                login_username: "",
                login_password: "",
                login_url: "",
            })
            setShowCredentials(false)
        } catch (error: any) {
            toast.error(error.message || "Failed to create environment")
        } finally {
            setIsLoading(false)
        }
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[525px]">
                <form onSubmit={handleSubmit}>
                    <DialogHeader>
                        <DialogTitle>Create New Environment</DialogTitle>
                        <DialogDescription>
                            Add a new test automation environment. Fill in the details below.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                        <div className="grid gap-2">
                            <Label htmlFor="name">Environment Name *</Label>
                            <Input
                                id="name"
                                value={formData.name}
                                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                                placeholder="E-Commerce Web App"
                                required
                            />
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="description">Description</Label>
                            <Textarea
                                id="description"
                                value={formData.description}
                                onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                                placeholder="Main shopping portal regression tests"
                                rows={3}
                            />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div className="grid gap-2">
                                <Label htmlFor="type">Type *</Label>
                                <Select value={formData.type} onValueChange={(value) => setFormData({ ...formData, type: value })}>
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="WEB">Web</SelectItem>
                                        <SelectItem value="MOBILE">Mobile</SelectItem>
                                        <SelectItem value="API">API</SelectItem>
                                        <SelectItem value="DESKTOP">Desktop</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="grid gap-2">
                                <Label htmlFor="status">Status</Label>
                                <Select value={formData.status} onValueChange={(value) => setFormData({ ...formData, status: value })}>
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="Active">Active</SelectItem>
                                        <SelectItem value="Draft">Draft</SelectItem>
                                        <SelectItem value="Archived">Archived</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>
                        <div className="grid gap-2">
                            <Label htmlFor="base_url">Base URL</Label>
                            <Input
                                id="base_url"
                                value={formData.base_url}
                                onChange={(e) => setFormData({ ...formData, base_url: e.target.value })}
                                placeholder="https://example.com"
                                type="url"
                            />
                        </div>

                        {/* ── Login Credentials (collapsible, Web only) ── */}
                        {formData.type === "WEB" && (
                            <div className="border rounded-lg overflow-hidden">
                                <button
                                    type="button"
                                    className="flex items-center gap-2 w-full p-3 text-sm font-medium text-left hover:bg-muted/50 transition-colors"
                                    onClick={() => setShowCredentials(!showCredentials)}
                                >
                                    <KeyRound className="h-4 w-4 text-muted-foreground" />
                                    <span>Login Credentials</span>
                                    <span className="text-xs text-muted-foreground ml-1">(optional – for auto-login)</span>
                                    {showCredentials ? (
                                        <ChevronDown className="h-4 w-4 ml-auto text-muted-foreground" />
                                    ) : (
                                        <ChevronRight className="h-4 w-4 ml-auto text-muted-foreground" />
                                    )}
                                </button>
                                {showCredentials && (
                                    <div className="grid gap-3 p-3 pt-0 border-t">
                                        <p className="text-xs text-muted-foreground">
                                            Provide credentials to auto-login before running tests. Stored encrypted.
                                        </p>
                                        <div className="grid gap-2">
                                            <Label htmlFor="login_url" className="text-xs">Login URL</Label>
                                            <Input
                                                id="login_url"
                                                value={formData.login_url}
                                                onChange={(e) => setFormData({ ...formData, login_url: e.target.value })}
                                                placeholder="https://example.com/login (defaults to Base URL)"
                                                type="url"
                                                className="h-8 text-sm"
                                            />
                                        </div>
                                        <div className="grid grid-cols-2 gap-3">
                                            <div className="grid gap-2">
                                                <Label htmlFor="login_username" className="text-xs">Username / Email</Label>
                                                <Input
                                                    id="login_username"
                                                    value={formData.login_username}
                                                    onChange={(e) => setFormData({ ...formData, login_username: e.target.value })}
                                                    placeholder="admin@example.com"
                                                    autoComplete="off"
                                                    className="h-8 text-sm"
                                                />
                                            </div>
                                            <div className="grid gap-2">
                                                <Label htmlFor="login_password" className="text-xs">Password</Label>
                                                <Input
                                                    id="login_password"
                                                    type="password"
                                                    value={formData.login_password}
                                                    onChange={(e) => setFormData({ ...formData, login_password: e.target.value })}
                                                    placeholder="••••••••"
                                                    autoComplete="new-password"
                                                    className="h-8 text-sm"
                                                />
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}

                        <div className="grid gap-2">
                            <Label htmlFor="tags">Tags (comma-separated)</Label>
                            <Input
                                id="tags"
                                value={formData.tags}
                                onChange={(e) => setFormData({ ...formData, tags: e.target.value })}
                                placeholder="regression, smoke, critical"
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isLoading}>
                            Cancel
                        </Button>
                        <Button type="submit" disabled={isLoading}>
                            {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                            Create Environment
                        </Button>
                    </DialogFooter>
                </form>
            </DialogContent>
        </Dialog>
    )
}
