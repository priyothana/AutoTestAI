"use client"

import { useState, useEffect } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import * as z from "zod"
import { Loader2, Save, User, Shield, Sliders, CheckCircle2, AlertCircle, Camera, Check } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { toast } from "sonner"

const profileSchema = z.object({
    full_name: z.string().min(2, "Name must be at least 2 characters").nullable().optional(),
    username: z.string().min(3, "Username must be at least 3 characters"),
    email: z.string().email("Invalid email address"),
})

const securitySchema = z.object({
    current_password: z.string().min(1, "Current password is required"),
    new_password: z.string().min(6, "Password must be at least 6 characters"),
    confirm_password: z.string().min(6, "Confirm password is required"),
}).refine((data) => data.new_password === data.confirm_password, {
    message: "Passwords do not match",
    path: ["confirm_password"],
})

type ProfileFormValues = z.infer<typeof profileSchema>
type SecurityFormValues = z.infer<typeof securitySchema>

const PRESET_AVATARS = [
    "https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=150&h=150&q=80",
    "https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=150&h=150&q=80",
    "https://images.unsplash.com/photo-1494790108377-be9c29b29330?auto=format&fit=crop&w=150&h=150&q=80",
    "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=150&h=150&q=80",
    "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?auto=format&fit=crop&w=150&h=150&q=80",
    "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?auto=format&fit=crop&w=150&h=150&q=80"
]

export default function ProfilePage() {
    const [isLoading, setIsLoading] = useState(true)
    const [isSaving, setIsSaving] = useState(false)
    const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
    const [showPresets, setShowPresets] = useState(false)

    const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000"

    const profileForm = useForm<ProfileFormValues>({
        resolver: zodResolver(profileSchema),
        defaultValues: {
            full_name: "",
            username: "",
            email: "",
        }
    })

    const securityForm = useForm<SecurityFormValues>({
        resolver: zodResolver(securitySchema),
        defaultValues: {
            current_password: "",
            new_password: "",
            confirm_password: "",
        }
    })

    // Fetch user details
    useEffect(() => {
        const fetchUserData = async () => {
            try {
                const res = await fetch(`${API_URL}/api/auth/me`)
                if (res.ok) {
                    const data = await res.json()
                    profileForm.reset({
                        full_name: data.full_name || "",
                        username: data.username || "",
                        email: data.email || "",
                    })
                    if (data.avatar_url) {
                        setAvatarUrl(data.avatar_url)
                    }
                }
            } catch (err) {
                console.error("Failed to fetch profile:", err)
                toast.error("Failed to load profile details")
            } finally {
                setIsLoading(false)
            }
        }
        fetchUserData()
    }, [API_URL, profileForm])

    const onProfileSubmit = async (values: ProfileFormValues) => {
        setIsSaving(true)
        try {
            const res = await fetch(`${API_URL}/api/auth/profile`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    full_name: values.full_name,
                    username: values.username,
                    email: values.email,
                    avatar_url: avatarUrl,
                })
            })

            if (res.ok) {
                const data = await res.json()
                // Update local storage token to refresh layout context
                if (data.access_token) {
                    localStorage.setItem("token", data.access_token)
                }
                toast.success("Profile details updated successfully")
                // Trigger a page refresh or layout context reload
                window.dispatchEvent(new Event("storage"))
            } else {
                const errData = await res.json()
                toast.error(errData.detail || "Failed to update profile")
            }
        } catch (err) {
            console.error("Update profile failed:", err)
            toast.error("Network error: Could not save profile changes")
        } finally {
            setIsSaving(false)
        }
    }

    const onSecuritySubmit = async (values: SecurityFormValues) => {
        setIsSaving(true)
        try {
            const res = await fetch(`${API_URL}/api/auth/profile`, {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    current_password: values.current_password,
                    new_password: values.new_password,
                })
            })

            if (res.ok) {
                securityForm.reset()
                toast.success("Password changed successfully")
            } else {
                const errData = await res.json()
                toast.error(errData.detail || "Failed to update password")
            }
        } catch (err) {
            console.error("Change password failed:", err)
            toast.error("Network error: Could not change password")
        } finally {
            setIsSaving(false)
        }
    }

    // Handles uploading image file and converting to Base64
    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0]
        if (file) {
            if (file.size > 2 * 1024 * 1024) {
                toast.error("Image file is too large (maximum size is 2MB)")
                return
            }
            const reader = new FileReader()
            reader.onloadend = () => {
                setAvatarUrl(reader.result as string)
                toast.info("Avatar updated. Don't forget to save changes!")
            }
            reader.readAsDataURL(file)
        }
    }

    if (isLoading) {
        return (
            <div className="flex h-[50vh] items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
        )
    }

    const initials = profileForm.getValues("username")?.substring(0, 2).toUpperCase() || "US"

    return (
        <div className="space-y-8 max-w-4xl mx-auto">
            {/* Header Section */}
            <div className="flex flex-col sm:flex-row items-center sm:items-start gap-6 border-b pb-6" style={{ borderColor: "var(--color-border-sem)" }}>
                <div className="relative group">
                    <Avatar className="h-24 w-24 border-2" style={{ borderColor: "var(--color-brand)" }}>
                        {avatarUrl && <AvatarImage src={avatarUrl} alt="User Avatar" />}
                        <AvatarFallback className="text-xl font-bold">{initials}</AvatarFallback>
                    </Avatar>
                    <label className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 flex flex-col items-center justify-center text-white text-xs rounded-full cursor-pointer transition-opacity">
                        <Camera className="h-4 w-4 mb-1" />
                        <span>Upload</span>
                        <input type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
                    </label>
                </div>

                <div className="flex-1 text-center sm:text-left space-y-2">
                    <h2 className="text-3xl font-bold tracking-tight">{profileForm.watch("full_name") || profileForm.watch("username")}</h2>
                    <p className="text-muted-foreground">{profileForm.watch("email")}</p>
                    <div className="flex flex-wrap gap-2 justify-center sm:justify-start pt-1">
                        <Button variant="outline" size="sm" onClick={() => setShowPresets(!showPresets)}>
                            Change Avatar Icon
                        </Button>
                        {avatarUrl && (
                            <Button variant="ghost" size="sm" className="text-destructive hover:bg-destructive/10" onClick={() => setAvatarUrl(null)}>
                                Remove Photo
                            </Button>
                        )}
                    </div>

                    {showPresets && (
                        <div className="flex gap-2.5 p-3 rounded-xl border mt-3 bg-muted/40 max-w-sm">
                            {PRESET_AVATARS.map((url, i) => (
                                <button
                                    key={i}
                                    type="button"
                                    onClick={() => {
                                        setAvatarUrl(url)
                                        setShowPresets(false)
                                        toast.info("Avatar updated. Click save changes to apply!")
                                    }}
                                    className="relative w-10 h-10 rounded-full overflow-hidden hover:scale-105 transition-transform"
                                >
                                    <img src={url} alt="Preset Avatar" className="w-full h-full object-cover" />
                                    {avatarUrl === url && (
                                        <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                                            <Check className="h-4 w-4 text-white" />
                                        </div>
                                    )}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Profile Tabs */}
            <Tabs defaultValue="general" className="w-full">
                <TabsList className="grid w-full md:w-[450px] grid-cols-3">
                    <TabsTrigger value="general" className="flex items-center gap-2">
                        <User className="h-4 w-4" /> General
                    </TabsTrigger>
                    <TabsTrigger value="security" className="flex items-center gap-2">
                        <Shield className="h-4 w-4" /> Security
                    </TabsTrigger>
                    <TabsTrigger value="preferences" className="flex items-center gap-2">
                        <Sliders className="h-4 w-4" /> Preferences
                    </TabsTrigger>
                </TabsList>

                {/* General Profile Form */}
                <TabsContent value="general" className="mt-6">
                    <form onSubmit={profileForm.handleSubmit(onProfileSubmit)}>
                        <Card>
                            <CardHeader>
                                <CardTitle>Profile Details</CardTitle>
                                <CardDescription>Update your personal information and contact details.</CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <div className="space-y-2">
                                    <Label htmlFor="full_name">Full Name</Label>
                                    <Input id="full_name" {...profileForm.register("full_name")} />
                                    {profileForm.formState.errors.full_name && (
                                        <p className="text-xs text-destructive">{profileForm.formState.errors.full_name.message}</p>
                                    )}
                                </div>
                                <div className="grid gap-4 md:grid-cols-2">
                                    <div className="space-y-2">
                                        <Label htmlFor="username">Username</Label>
                                        <Input id="username" {...profileForm.register("username")} />
                                        {profileForm.formState.errors.username && (
                                            <p className="text-xs text-destructive">{profileForm.formState.errors.username.message}</p>
                                        )}
                                    </div>
                                    <div className="space-y-2">
                                        <Label htmlFor="email">Email Address</Label>
                                        <Input id="email" type="email" {...profileForm.register("email")} />
                                        {profileForm.formState.errors.email && (
                                            <p className="text-xs text-destructive">{profileForm.formState.errors.email.message}</p>
                                        )}
                                    </div>
                                </div>
                            </CardContent>
                            <CardFooter className="flex justify-end gap-2 border-t pt-4">
                                <Button type="submit" disabled={isSaving}>
                                    {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                                    Save Changes
                                </Button>
                            </CardFooter>
                        </Card>
                    </form>
                </TabsContent>

                {/* Password / Security Form */}
                <TabsContent value="security" className="mt-6">
                    <form onSubmit={securityForm.handleSubmit(onSecuritySubmit)}>
                        <Card>
                            <CardHeader>
                                <CardTitle>Change Password</CardTitle>
                                <CardDescription>Keep your account secure by updating your credentials regularly.</CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <div className="space-y-2">
                                    <Label htmlFor="current_password">Current Password</Label>
                                    <Input id="current_password" type="password" {...securityForm.register("current_password")} />
                                    {securityForm.formState.errors.current_password && (
                                        <p className="text-xs text-destructive">{securityForm.formState.errors.current_password.message}</p>
                                    )}
                                </div>
                                <div className="grid gap-4 md:grid-cols-2">
                                    <div className="space-y-2">
                                        <Label htmlFor="new_password">New Password</Label>
                                        <Input id="new_password" type="password" {...securityForm.register("new_password")} />
                                        {securityForm.formState.errors.new_password && (
                                            <p className="text-xs text-destructive">{securityForm.formState.errors.new_password.message}</p>
                                        )}
                                    </div>
                                    <div className="space-y-2">
                                        <Label htmlFor="confirm_password">Confirm New Password</Label>
                                        <Input id="confirm_password" type="password" {...securityForm.register("confirm_password")} />
                                        {securityForm.formState.errors.confirm_password && (
                                            <p className="text-xs text-destructive">{securityForm.formState.errors.confirm_password.message}</p>
                                        )}
                                    </div>
                                </div>
                            </CardContent>
                            <CardFooter className="flex justify-end gap-2 border-t pt-4">
                                <Button type="submit" disabled={isSaving}>
                                    {isSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
                                    Update Password
                                </Button>
                            </CardFooter>
                        </Card>
                    </form>
                </TabsContent>

                {/* Preferences tab */}
                <TabsContent value="preferences" className="mt-6">
                    <Card>
                        <CardHeader>
                            <CardTitle>System Preferences</CardTitle>
                            <CardDescription>Personalize your experience on the platform.</CardDescription>
                        </CardHeader>
                        <CardContent className="space-y-4">
                            <div className="flex items-center justify-between rounded-lg border p-4 shadow-sm">
                                <div className="space-y-0.5">
                                    <Label className="text-base">Console Audio Alerts</Label>
                                    <p className="text-xs text-muted-foreground">Play sound alerts when a test execution finishes with errors.</p>
                                </div>
                                <div className="flex h-6 items-center">
                                    <input type="checkbox" className="h-4 w-4 accent-primary" defaultChecked />
                                </div>
                            </div>
                            <div className="flex items-center justify-between rounded-lg border p-4 shadow-sm">
                                <div className="space-y-0.5">
                                    <Label className="text-base">Weekly Summary Emails</Label>
                                    <p className="text-xs text-muted-foreground">Receive weekly performance updates for all running automation project suites.</p>
                                </div>
                                <div className="flex h-6 items-center">
                                    <input type="checkbox" className="h-4 w-4 accent-primary" />
                                </div>
                            </div>
                        </CardContent>
                        <CardFooter className="flex justify-end gap-2 border-t pt-4">
                            <Button onClick={() => toast.success("Preferences updated successfully")}>
                                <Save className="mr-2 h-4 w-4" /> Save Preferences
                            </Button>
                        </CardFooter>
                    </Card>
                </TabsContent>
            </Tabs>
        </div>
    )
}
