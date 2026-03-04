"use client"

import { useState, useEffect } from "react"
import { useRouter } from "next/navigation"
import { Plus, Search, Edit, Trash2, Eye, Loader2, Check, X } from "lucide-react"
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
    const [deleteProjectId, setDeleteProjectId] = useState<string | null>(null)
    const [page, setPage] = useState(0)
    const [hasMore, setHasMore] = useState(true)
    const [integrationStatuses, setIntegrationStatuses] = useState<Record<string, string>>({})

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

            const response = await fetch(`http://localhost:8000/api/v1/projects/?${params}`)
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
                        const intRes = await fetch(`http://localhost:8000/api/v1/projects/${p.id}/integration-status`)
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

    const handleDelete = async (id: string) => {
        try {
            const response = await fetch(`http://localhost:8000/api/v1/projects/${id}`, {
                method: "DELETE"
            })

            if (!response.ok) throw new Error("Failed to delete project")

            toast.success("Project archived successfully")
            fetchProjects()
        } catch (error) {
            toast.error("Failed to delete project")
        } finally {
            setDeleteProjectId(null)
        }
    }

    const getStatusBadgeVariant = (status: string) => {
        switch (status) {
            case "Active": return "default"
            case "Draft": return "secondary"
            case "Archived": return "outline"
            default: return "default"
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
                    <h2 className="text-3xl font-bold tracking-tight">Projects</h2>
                    <p className="text-muted-foreground">Manage your test automation projects</p>
                </div>
                <Button onClick={() => router.push("/dashboard/projects/create")} className="bg-green-600 hover:bg-green-700">
                    <Plus className="mr-2 h-4 w-4" />
                    Create New Project
                </Button>
            </div>

            {/* Filters */}
            <div className="flex flex-col sm:flex-row gap-4">
                <div className="relative flex-1">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                        type="search"
                        placeholder="Search projects by name or description..."
                        className="pl-8"
                        value={searchQuery}
                        onChange={(e) => {
                            setSearchQuery(e.target.value)
                            setPage(0)
                        }}
                    />
                </div>
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
                                    <TableHead>Project Name</TableHead>
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
                                    <TableRow key={project.id}>
                                        <TableCell className="font-medium">
                                            <Link href={`/dashboard/projects/${project.id}`} className="hover:underline">
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
                                            <Badge variant={getStatusBadgeVariant(project.status)}>
                                                {project.status}
                                            </Badge>
                                        </TableCell>
                                        <TableCell>
                                            {integrationStatuses[project.id] === "connected" ? (
                                                <Badge className="bg-green-100 text-green-700 border-green-200 hover:bg-green-100">
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
                                            <div className="flex justify-end gap-2">
                                                <Button variant="ghost" size="sm" asChild>
                                                    <Link href={`/dashboard/projects/${project.id}`}>
                                                        <Eye className="h-4 w-4" />
                                                    </Link>
                                                </Button>
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={() => setDeleteProjectId(project.id)}
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
                            <div key={project.id} className="border rounded-lg p-4 space-y-3">
                                <div className="flex items-start justify-between">
                                    <div className="flex-1">
                                        <Link href={`/dashboard/projects/${project.id}`}>
                                            <h3 className="font-semibold hover:underline">{project.name}</h3>
                                        </Link>
                                        <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                                            {project.description || "No description"}
                                        </p>
                                    </div>
                                    <Badge variant={getStatusBadgeVariant(project.status)}>
                                        {project.status}
                                    </Badge>
                                </div>
                                <div className="flex items-center gap-2 text-sm">
                                    <Badge variant="outline">{project.type}</Badge>
                                    <span className="text-muted-foreground">•</span>
                                    {integrationStatuses[project.id] === "connected" ? (
                                        <Badge className="bg-green-100 text-green-700 border-green-200 hover:bg-green-100 text-xs">
                                            <Check className="h-3 w-3 mr-1" /> Connected
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
                                    <Button variant="outline" size="sm" className="flex-1" asChild>
                                        <Link href={`/dashboard/projects/${project.id}`}>
                                            <Eye className="mr-2 h-4 w-4" />
                                            View
                                        </Link>
                                    </Button>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={() => setDeleteProjectId(project.id)}
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



            {/* Delete Confirmation */}
            <AlertDialog open={!!deleteProjectId} onOpenChange={() => setDeleteProjectId(null)}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>Archive Project?</AlertDialogTitle>
                        <AlertDialogDescription>
                            This will archive the project. You can restore it later from archived projects.
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction onClick={() => deleteProjectId && handleDelete(deleteProjectId)}>
                            Archive
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    )
}
