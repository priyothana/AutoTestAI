"use client"

import { useState, useEffect } from "react"
import { Users, Mail, Plus, Trash2, ShieldCheck, UserCheck, ShieldAlert, Loader2, ArrowRightLeft } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "@/components/ui/card"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { toast } from "sonner"

interface Project {
    id: string
    name: string
}

interface Member {
    id: number | null
    email: string
    username: string | null
    full_name: string | null
    avatar_url: string | null
    role: "Admin" | "Member" | "Viewer"
    status: "active" | "pending"
    is_owner?: boolean
}

export default function TeamPage() {
    const [projects, setProjects] = useState<Project[]>([])
    const [selectedProjectId, setSelectedProjectId] = useState<string>("")
    const [members, setMembers] = useState<Member[]>([])
    const [isLoadingProjects, setIsLoadingProjects] = useState(true)
    const [isLoadingMembers, setIsLoadingMembers] = useState(false)
    const [isInviting, setIsInviting] = useState(false)

    // Form inputs
    const [inviteEmail, setInviteEmail] = useState("")
    const [inviteRole, setInviteRole] = useState<"Admin" | "Member" | "Viewer">("Member")

    const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000"

    // Load projects on load
    useEffect(() => {
        const fetchProjects = async () => {
            try {
                const res = await fetch(`${API_URL}/api/v1/projects?limit=100`)
                if (res.ok) {
                    const data = await res.json()
                    const projList = Array.isArray(data) ? data : []
                    setProjects(projList)
                    if (projList.length > 0) {
                        setSelectedProjectId(projList[0].id)
                    }
                }
            } catch (err) {
                console.error("Failed to load projects:", err)
                toast.error("Failed to load project environments")
            } finally {
                setIsLoadingProjects(false)
            }
        }
        fetchProjects()
    }, [API_URL])

    // Load members whenever selected project changes
    useEffect(() => {
        if (!selectedProjectId) return

        const fetchMembers = async () => {
            setIsLoadingMembers(true)
            try {
                const res = await fetch(`${API_URL}/api/v1/projects/${selectedProjectId}/members`)
                if (res.ok) {
                    const data = await res.json()
                    setMembers(data)
                }
            } catch (err) {
                console.error("Failed to load members:", err)
                toast.error("Failed to load team members")
            } finally {
                setIsLoadingMembers(false)
            }
        }
        fetchMembers()
    }, [API_URL, selectedProjectId])

    // Invite new member
    const handleInvite = async (e: React.FormEvent) => {
        e.preventDefault()
        if (!inviteEmail) return
        if (!selectedProjectId) {
            toast.error("Please select a project to invite the user to")
            return
        }

        setIsInviting(true)
        try {
            const res = await fetch(`${API_URL}/api/v1/projects/${selectedProjectId}/members`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email: inviteEmail, role: inviteRole })
            })

            if (res.ok) {
                const newMember = await res.json()
                setMembers(prev => [...prev, newMember])
                setInviteEmail("")
                toast.success(`Invitation sent successfully to ${inviteEmail}`)
            } else {
                const errData = await res.json()
                toast.error(errData.detail || "Failed to invite member")
            }
        } catch (err) {
            console.error("Invitation failed:", err)
            toast.error("Network error: Could not complete invitation")
        } finally {
            setIsInviting(false)
        }
    }

    // Update role
    const handleUpdateRole = async (email: string, newRole: "Admin" | "Member" | "Viewer") => {
        try {
            const res = await fetch(`${API_URL}/api/v1/projects/${selectedProjectId}/members/${encodeURIComponent(email)}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ role: newRole })
            })

            if (res.ok) {
                setMembers(prev => prev.map(m => m.email === email ? { ...m, role: newRole } : m))
                toast.success(`Role updated to ${newRole} for ${email}`)
            } else {
                const errData = await res.json()
                toast.error(errData.detail || "Failed to update role")
            }
        } catch (err) {
            console.error("Role update failed:", err)
            toast.error("Network error: Could not update role")
        }
    }

    // Revoke membership
    const handleRevoke = async (email: string) => {
        if (!window.confirm(`Are you sure you want to remove ${email} from this project?`)) return

        try {
            const res = await fetch(`${API_URL}/api/v1/projects/${selectedProjectId}/members/${encodeURIComponent(email)}`, {
                method: "DELETE"
            })

            if (res.ok || res.status === 204) {
                setMembers(prev => prev.filter(m => m.email !== email))
                toast.success(`Member ${email} removed successfully`)
            } else {
                const errData = await res.json()
                toast.error(errData.detail || "Failed to remove member")
            }
        } catch (err) {
            console.error("Revocation failed:", err)
            toast.error("Network error: Could not remove member")
        }
    }

    if (isLoadingProjects) {
        return (
            <div className="flex h-[50vh] items-center justify-center">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
            </div>
        )
    }

    return (
        <div className="space-y-8 max-w-5xl mx-auto">
            {/* Header section with project context */}
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b pb-6" style={{ borderColor: "var(--color-border-sem)" }}>
                <div>
                    <h2 className="text-3xl font-bold tracking-tight">Team Management</h2>
                    <p className="text-muted-foreground">Invite collaborators, manage roles, and review environment access levels.</p>
                </div>
                <div className="flex items-center gap-3">
                    <Label htmlFor="project-select" className="text-sm font-semibold shrink-0">Environment Context:</Label>
                    {projects.length > 0 ? (
                        <Select value={selectedProjectId} onValueChange={setSelectedProjectId}>
                            <SelectTrigger id="project-select" className="w-[200px] md:w-[260px]">
                                <SelectValue placeholder="Select Environment" />
                            </SelectTrigger>
                            <SelectContent>
                                {projects.map((p) => (
                                    <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    ) : (
                        <span className="text-sm text-muted-foreground border p-2 rounded bg-muted/40">No environments active</span>
                    )}
                </div>
            </div>

            {/* Team details & Invite forms */}
            <div className="grid gap-6 md:grid-cols-3 items-start">
                {/* Members list */}
                <Card className="md:col-span-2">
                    <CardHeader className="flex flex-row items-center justify-between">
                        <div>
                            <CardTitle className="text-lg font-bold flex items-center gap-2">
                                <Users className="h-5 w-5 text-muted-foreground" />
                                Team Members
                            </CardTitle>
                            <CardDescription>Collaborators assigned to this environment.</CardDescription>
                        </div>
                        {isLoadingMembers && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
                    </CardHeader>
                    <CardContent className="p-0">
                        {projects.length === 0 ? (
                            <div className="p-8 text-center text-sm text-muted-foreground">
                                Create an environment project first before managing its members.
                            </div>
                        ) : members.length === 0 ? (
                            <div className="p-8 text-center text-sm text-muted-foreground">
                                No members assigned yet.
                            </div>
                        ) : (
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead className="pl-6">User</TableHead>
                                        <TableHead>Role</TableHead>
                                        <TableHead>Status</TableHead>
                                        <TableHead className="text-right pr-6">Action</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {members.map((member) => {
                                        const initials = member.username?.substring(0, 2).toUpperCase() || member.email.substring(0, 2).toUpperCase()
                                        return (
                                            <TableRow key={member.email}>
                                                <TableCell className="pl-6 flex items-center gap-3">
                                                    <Avatar className="h-9 w-9">
                                                        {member.avatar_url && <AvatarImage src={member.avatar_url} />}
                                                        <AvatarFallback>{initials}</AvatarFallback>
                                                    </Avatar>
                                                    <div className="flex flex-col">
                                                        <span className="text-sm font-semibold">{member.full_name || member.username || "Invited User"}</span>
                                                        <span className="text-xs text-muted-foreground">{member.email}</span>
                                                    </div>
                                                </TableCell>
                                                <TableCell>
                                                    {member.is_owner ? (
                                                        <Badge variant="outline" className="gap-1 text-purple-700 bg-purple-50 border-purple-200">
                                                            <ShieldAlert className="h-3 w-3" /> Owner
                                                        </Badge>
                                                    ) : (
                                                        <Select
                                                            value={member.role}
                                                            onValueChange={(val: any) => handleUpdateRole(member.email, val)}
                                                        >
                                                            <SelectTrigger className="w-[110px] h-8 text-xs">
                                                                <SelectValue />
                                                            </SelectTrigger>
                                                            <SelectContent>
                                                                <SelectItem value="Admin">Admin</SelectItem>
                                                                <SelectItem value="Member">Member</SelectItem>
                                                                <SelectItem value="Viewer">Viewer</SelectItem>
                                                            </SelectContent>
                                                        </Select>
                                                    )}
                                                </TableCell>
                                                <TableCell>
                                                    {member.status === "active" ? (
                                                        <Badge variant="outline" style={{ backgroundColor: '#D6E5BD', color: '#15803d', borderColor: '#c2d1a7' }} className="gap-1">
                                                            <UserCheck className="h-3 w-3" /> Active
                                                        </Badge>
                                                    ) : (
                                                        <Badge variant="outline" className="gap-1 text-amber-700 bg-amber-50 border-amber-200">
                                                            Pending
                                                        </Badge>
                                                    )}
                                                </TableCell>
                                                <TableCell className="text-right pr-6">
                                                    {!member.is_owner && (
                                                        <Button
                                                            variant="ghost"
                                                            size="icon"
                                                            className="text-destructive hover:bg-destructive/10"
                                                            title="Remove member"
                                                            onClick={() => handleRevoke(member.email)}
                                                        >
                                                            <Trash2 className="h-4 w-4" />
                                                        </Button>
                                                    )}
                                                </TableCell>
                                            </TableRow>
                                        )
                                    })}
                                </TableBody>
                            </Table>
                        )}
                    </CardContent>
                </Card>

                {/* Invite Collaborator Card */}
                <Card>
                    <CardHeader>
                        <CardTitle className="text-lg font-bold flex items-center gap-2">
                            <Mail className="h-5 w-5 text-muted-foreground" />
                            Invite Member
                        </CardTitle>
                        <CardDescription>Grant collaborator access to the current project context.</CardDescription>
                    </CardHeader>
                    <form onSubmit={handleInvite}>
                        <CardContent className="space-y-4">
                            <div className="space-y-1">
                                <Label htmlFor="email-invite">Email Address</Label>
                                <Input
                                    id="email-invite"
                                    type="email"
                                    placeholder="developer@company.com"
                                    value={inviteEmail}
                                    onChange={(e) => setInviteEmail(e.target.value)}
                                    required
                                    disabled={projects.length === 0}
                                />
                            </div>
                            <div className="space-y-1">
                                <Label htmlFor="role-invite">Role Access Level</Label>
                                <Select
                                    value={inviteRole}
                                    onValueChange={(val: any) => setInviteRole(val)}
                                    disabled={projects.length === 0}
                                >
                                    <SelectTrigger id="role-invite" className="w-full">
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="Admin">Admin (Full Edit & Team config)</SelectItem>
                                        <SelectItem value="Member">Member (Read & Execute tests)</SelectItem>
                                        <SelectItem value="Viewer">Viewer (Read-only dashboard view)</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                        </CardContent>
                        <CardFooter className="border-t pt-4">
                            <Button type="submit" className="w-full" disabled={isInviting || projects.length === 0}>
                                {isInviting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
                                Send Invite
                            </Button>
                        </CardFooter>
                    </form>
                </Card>
            </div>
        </div>
    )
}
