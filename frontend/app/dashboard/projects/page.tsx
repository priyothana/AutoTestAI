"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Plus, Search, Trash2, Eye, Loader2, Check, X, Archive, ExternalLink } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { EmptyState } from "@/components/projects/EmptyState"
import { toast } from "sonner"
import Link from "next/link"

interface Project {
    id: string
    name: string
    description: string
    type: string
    status: string
    tags: string[]
    created_at: string
    updated_at: string
}

export default function ProjectsPage() {
    const router = useRouter()
    const [projects, setProjects] = useState<Project[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const [searchQuery, setSearchQuery] = useState("")
    const [statusFilter, setStatusFilter] = useState<string>("all")
    const [typeFilter, setTypeFilter] = useState<string>("all")
    const [archiveProjectId, setArchiveProjectId] = useState<string | null>(null)
    const [deleteProjectId, setDeleteProjectId] = useState<string | null>(null)
    const [page, setPage] = useState(0)
    const [hasMore, setHasMore] = useState(true)
    const [integrationStatuses, setIntegrationStatuses] = useState<Record<string, string>>({})
    const [mounted, setMounted] = useState(false)

    useEffect(() => {
        setMounted(true)
    }, [])

    const fetchProjects = async () => {
        setIsLoading(true)
        try {
            const params = new URLSearchParams({
                skip: (page * 10).toString(),
                limit: "10"
            })

            if (searchQuery) params.append("search", searchQuery)
            if (statusFilter !== "all") params.append("status", statusFilter)
            if (typeFilter !== "all") params.append("type", typeFilter)

            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/?${params}`)
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.detail || `Failed to fetch projects (${response.status})`);
            }

            const data = await response.json()
            const projectsList = Array.isArray(data) ? data : []
            setProjects(projectsList)
            setHasMore(projectsList.length === 10)

            // Fetch integration status for each project
            const statuses: Record<string, string> = {}
            await Promise.all(
                projectsList.map(async (p: Project) => {
                    try {
                        const intRes = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${p.id}/integration-status`)
                        if (intRes.ok) {
                            const intData = await intRes.json()
                            statuses[p.id] = intData.status || "disconnected"
                        } else {
                            statuses[p.id] = "disconnected"
                        }
                    } catch {
                        statuses[p.id] = "disconnected"
                    }
                })
            )
            setIntegrationStatuses(statuses)
        } catch (error: any) {
            console.error("Failed to fetch projects:", error)
            toast.error(error.message || "Connection error: Could not reach the backend server.")
        } finally {
            setIsLoading(false)
        }
    }

    useEffect(() => {
        fetchProjects()
    }, [page, searchQuery, statusFilter, typeFilter])

    const handleArchive = async (id: string) => {
        try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${id}`, {
                method: "DELETE"
            })
            if (!response.ok) throw new Error("Failed to archive project")
            toast.success("Environment archived successfully")
            fetchProjects()
        } catch (error) {
            toast.error("Failed to archive environment")
        } finally {
            setArchiveProjectId(null)
        }
    }

    const handleDelete = async (id: string) => {
        try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/projects/${id}/permanent`, {
                method: "DELETE"
            })
            if (!response.ok) throw new Error("Failed to delete project")
            toast.success("Environment permanently deleted")
            fetchProjects()
        } catch (error) {
            toast.error("Failed to delete environment")
        } finally {
            setDeleteProjectId(null)
        }
    }

    // IMPROVEMENT 4 — Status badge colour classes
    const getStatusBadgeClass = (status: string) => {
        switch (status) {
            case "Active": return "bg-green-50 text-green-700 border border-green-200"
            case "Draft": return "bg-amber-50 text-amber-700 border border-amber-200"
            case "Archived": return "bg-gray-100 text-gray-500 border border-gray-200"
            default: return "bg-green-50 text-green-700 border border-green-200"
        }
    }

    const formatDate = (dateString: string) => {
        const date = new Date(dateString)
        return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    }

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight">Environments</h2>
                    <p className="text-muted-foreground">Manage your test automation environments</p>
                </div>
                <Button onClick={() => router.push("/dashboard/projects/create")} className="bg-green-600 hover:bg-green-700">
                    <Plus className="mr-2 h-4 w-4" />
                    Create New Environment
                </Button>
            </div>

            {/* Filters */}
            <div className="flex flex-col sm:flex-row gap-4">
                <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                        type="search"
                        placeholder="Search environments by name or description..."
                        className="pl-8"
                        value={searchQuery}
                        onChange={(e) => {
                            setSearchQuery(e.target.value)
                            setPage(0)
                        }}
                    />
                </div>
                {mounted ? (
                    <Select value={statusFilter} onValueChange={(value) => { setStatusFilter(value); setPage(0) }}>
                        <SelectTrigger className="w-full sm:w-[180px]">
                            <SelectValue placeholder="Filter by status" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All Statuses</SelectItem>
                            <SelectItem value="Active">Active</SelectItem>
                            <SelectItem value="Draft">Draft</SelectItem>
                            <SelectItem value="Archived">Archived</SelectItem>
                        </SelectContent>
                    </Select>
                ) : (
                    <div className="w-full sm:w-[180px] h-10 rounded-md border border-input bg-background" />
                )}
                {mounted ? (
                    <Select value={typeFilter} onValueChange={(value) => { setTypeFilter(value); setPage(0) }}>
                        <SelectTrigger className="w-full sm:w-[180px]">
                            <SelectValue placeholder="Filter by type" />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">All Types</SelectItem>
                            <SelectItem value="WEB">Web</SelectItem>
                            <SelectItem value="MOBILE">Mobile</SelectItem>
                            <SelectItem value="API">API</SelectItem>
                            <SelectItem value="DESKTOP">Desktop</SelectItem>
                        </SelectContent>
                    </Select>
                ) : (
                    <div className="w-full sm:w-[180px] h-10 rounded-md border border-input bg-background" />
                )}
            </div>

            {/* Content */}
            {isLoading ? (
                <div className="flex items-center justify-center py-16">
                    <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
                </div>
            ) : projects.length === 0 ? (
                <EmptyState onCreateClick={() => router.push("/dashboard/projects/create")} />
            ) : (
                <>
                    {/* Desktop Table */}
                    <div className="hidden md:block border rounded-lg">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Environment Name</TableHead>
                                    <TableHead>Description</TableHead>
                                    <TableHead>Type</TableHead>
                                    <TableHead>Status</TableHead>
                                    <TableHead>Connection</TableHead>
                                    <TableHead>Created</TableHead>
                                    <TableHead className="text-right">Actions</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {projects.map((project) => (
                                    // IMPROVEMENT 1 — Row hover highlight
                                    // IMPROVEMENT 3 — Row click opens project detail
                                    <TableRow
                                        key={project.id}
                                        className="group hover:bg-muted/50 cursor-pointer transition-colors"
                                        onClick={() => router.push(`/dashboard/projects/${project.id}`)}
                                    >
                                        <TableCell className="font-medium">
                                            <Link
                                                href={`/dashboard/projects/${project.id}`}
                                                className="hover:underline"
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                {project.name}
                                            </Link>
                                        </TableCell>
                                        <TableCell className="max-w-md truncate">
                                            {project.description || "No description"}
                                        </TableCell>
                                        <TableCell>
                                            <Badge variant="outline">{project.type}</Badge>
                                        </TableCell>
                                        <TableCell>
                                            {/* IMPROVEMENT 4 — Colour-coded status badge */}
                                            <Badge
                                                variant="outline"
                                                className={`capitalize ${getStatusBadgeClass(project.status)}`}
                                            >
                                                {project.status}
                                            </Badge>
                                        </TableCell>
                                        <TableCell>
                                            {integrationStatuses[project.id] === "connected" ? (
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
                                        </TableCell>
                                        <TableCell>{formatDate(project.created_at)}</TableCell>
                                        <TableCell className="text-right">
                                            {/* IMPROVEMENT 2 — Inline View button + existing action buttons */}
                                            <div className="flex justify-end items-center gap-1">

                                                {/* Inline View button — hidden by default, visible on row hover */}
                                                <Link
                                                    href={`/dashboard/projects/${project.id}`}
                                                    onClick={(e) => e.stopPropagation()}
                                                >
                                                    <button
                                                        className="opacity-0 group-hover:opacity-100 transition-opacity duration-150
                                                                   px-2 py-1 text-xs rounded
                                                                   bg-transparent hover:bg-blue-50
                                                                   text-blue-600 border border-blue-200"
                                                    >
                                                        <ExternalLink className="inline h-3 w-3 mr-1" />
                                                        View
                                                    </button>
                                                </Link>

                                                {/* Existing Eye icon button — unchanged */}
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    asChild
                                                    onClick={(e) => e.stopPropagation()}
                                                >
                                                    <Link href={`/dashboard/projects/${project.id}`}>
                                                        <Eye className="h-4 w-4" />
                                                    </Link>
                                                </Button>

                                                {/* Existing Archive button — unchanged */}
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    title="Archive environment"
                                                    onClick={(e) => {
                                                        e.stopPropagation()
                                                        setArchiveProjectId(project.id)
                                                    }}
                                                >
                                                    <Archive className="h-4 w-4 text-amber-500" />
                                                </Button>

                                                {/* Existing Delete button — unchanged */}
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    title="Permanently delete environment"
                                                    onClick={(e) => {
                                                        e.stopPropagation()
                                                        setDeleteProjectId(project.id)
                                                    }}
                                                >
                                                    <Trash2 className="h-4 w-4 text-destructive" />
                                                </Button>
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>

                    {/* Mobile Cards */}
                    <div className="md:hidden space-y-4">
                        {projects.map((project) => (
                            // Mobile card — IMPROVEMENT 1 + 3: hover highlight + clickable card
                            <div
                                key={project.id}
                                className="border rounded-lg p-4 space-y-3 hover:bg-muted/50 cursor-pointer transition-colors"
                                onClick={() => router.push(`/dashboard/projects/${project.id}`)}
                            >
                                <div className="flex items-start justify-between">
                                    <div className="flex-1">
                                        <Link
                                            href={`/dashboard/projects/${project.id}`}
                                            onClick={(e) => e.stopPropagation()}
                                        >
                                            <h3 className="font-semibold hover:underline">{project.name}</h3>
                                        </Link>
                                        <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                                            {project.description || "No description"}
                                        </p>
                                    </div>
                                    {/* IMPROVEMENT 4 — Colour-coded status badge (mobile) */}
                                    <Badge
                                        variant="outline"
                                        className={`capitalize ${getStatusBadgeClass(project.status)}`}
                                    >
                                        {project.status}
                                    </Badge>
                                </div>
                                <div className="flex items-center gap-2 text-sm">
                                    <Badge variant="outline">{project.type}</Badge>
                                    <span className="text-muted-foreground">•</span>
                                    {integrationStatuses[project.id] === "connected" ? (
                                        <Badge
                                            variant="outline"
                                            style={{ backgroundColor: '#D6E5BD', color: '#15803d', borderColor: '#c2d1a7' }}
                                            className="hover:opacity-90 text-xs font-medium px-3 py-1 rounded-full flex items-center gap-1"
                                        >
                                            <Check className="h-3.5 w-3.5" />
                                            Connected
                                        </Badge>
                                    ) : (
                                        <Badge variant="outline" className="text-muted-foreground text-xs">
                                            <X className="h-3 w-3 mr-1" /> Not Connected
                                        </Badge>
                                    )}
                                    <span className="text-muted-foreground">•</span>
                                    <span className="text-muted-foreground">{formatDate(project.created_at)}</span>
                                </div>
                                <div className="flex gap-2 pt-2">
                                    <Button variant="outline" size="sm" className="flex-1" asChild
                                        onClick={(e: React.MouseEvent) => e.stopPropagation()}
                                    >
                                        <Link href={`/dashboard/projects/${project.id}`}>
                                            <Eye className="mr-2 h-4 w-4" />
                                            View
                                        </Link>
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        title="Archive environment"
                                        onClick={(e) => {
                                            e.stopPropagation()
                                            setArchiveProjectId(project.id)
                                        }}
                                    >
                                        <Archive className="h-4 w-4 text-amber-500" />
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        title="Permanently delete"
                                        onClick={(e) => {
                                            e.stopPropagation()
                                            setDeleteProjectId(project.id)
                                        }}
                                    >
                                        <Trash2 className="h-4 w-4 text-destructive" />
                                    </Button>
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* Pagination */}
                    <div className="flex items-center justify-between">
                        <Button
                            variant="outline"
                            onClick={() => setPage(p => Math.max(0, p - 1))}
                            disabled={page === 0}
                        >
                            Previous
                        </Button>
                        <span className="text-sm text-muted-foreground">
                            Page {page + 1}
                        </span>
                        <Button
                            variant="outline"
                            onClick={() => setPage(p => p + 1)}
                            disabled={!hasMore}
                        >
                            Next
                        </Button>
                    </div>
                </>
            )}


            {/* Archive Confirmation */}
            <AlertDialog open={!!archiveProjectId} onOpenChange={() => setArchiveProjectId(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle className="flex items-center gap-2">
                            <Archive className="h-5 w-5 text-amber-500" />
                            Archive Environment?
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            This will archive the environment and hide it from the default list. You can restore it later by changing its status back to Active.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            className="bg-amber-500 hover:bg-amber-600 text-white"
                            onClick={() => archiveProjectId && handleArchive(archiveProjectId)}
                        >
                            Archive
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>

            {/* Permanent Delete Confirmation */}
            <AlertDialog open={!!deleteProjectId} onOpenChange={() => setDeleteProjectId(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle className="flex items-center gap-2 text-destructive">
                            <Trash2 className="h-5 w-5" />
                            Permanently Delete Environment?
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            <span className="font-semibold text-foreground">This action cannot be undone.</span> The environment and all its associated test cases, executions, and integration data will be permanently removed from the database.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                            className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
                            onClick={() => deleteProjectId && handleDelete(deleteProjectId)}
                        >
                            Delete Permanently
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    )
}
