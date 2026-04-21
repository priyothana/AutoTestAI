"use client"

import Link from "next/link"
import { Plus, Search, Play, Edit, MoreVertical, FileText, Loader2, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { toast } from "sonner"
import { useEffect, useState } from "react"
import { format } from "date-fns"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table"
import { useRouter } from "next/navigation"

interface TestCase {
    id: string
    name: string
    project_id: string
    project_name: string
    description: string
    steps: any[]
    priority: string
    created_at: string
}

// IMPROVEMENT 4 — Priority badge colour map
const priorityStyles: Record<string, string> = {
    high: "bg-red-50 text-red-700 border border-red-200",
    medium: "bg-amber-50 text-amber-700 border border-amber-200",
    low: "bg-green-50 text-green-700 border border-green-200",
}

export default function TestsPage() {
    const [tests, setTests] = useState<TestCase[]>([])
    const [isLoading, setIsLoading] = useState(true)
    const router = useRouter()

    const fetchTests = async () => {
        setIsLoading(true)
        try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/tests`)
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.detail || `Failed to fetch tests (${response.status})`);
            }
            const data = await response.json()
            setTests(Array.isArray(data) ? data : [])
        } catch (error: any) {
            console.error("Failed to fetch tests:", error)
            toast.error(error.message || "Connection error: Could not reach the backend server.")
        } finally {
            setIsLoading(false)
        }
    }

    useEffect(() => {
        fetchTests()
    }, [])

    const handleRunTest = async (testId: string) => {
        try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/test-runs`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ test_case_id: testId })
            })

            if (!response.ok) throw new Error("Failed to start test execution")

            toast.success("Test execution started!")
        } catch (error) {
            console.error("Run error:", error)
            toast.error("Failed to start test execution")
        }
    }

    const handleDeleteTest = async (e: React.MouseEvent, testId: string) => {
        e.stopPropagation()
        if (!window.confirm("Are you sure you want to delete this test case? This action cannot be undone.")) return
        try {
            const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/tests/${testId}`, {
                method: "DELETE",
            })
            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}))
                throw new Error(errorData.detail || `Failed to delete test (${response.status})`)
            }
            setTests((prev) => prev.filter((t) => t.id !== testId))
            toast.success("Test case deleted successfully.")
        } catch (error: any) {
            console.error("Delete error:", error)
            toast.error(error.message || "Failed to delete test case.")
        }
    }

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="page-title">Test Cases</h2>
                    <p className="page-subtitle">Manage and execute your automated test scenarios.</p>
                </div>
                <Button asChild>
                    <Link href="/dashboard/tests/create">
                        <Plus className="mr-2 h-4 w-4" />
                        New Test Case
                    </Link>
                </Button>
            </div>

            <div className="flex items-center gap-2">
                <div className="relative flex-1 max-w-sm">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4" style={{ color: 'var(--color-text-muted)' }} />
                    <Input type="search" placeholder="Search tests..." className="pl-8" />
                </div>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>All Tests</CardTitle>
                    <CardDescription>List of all test cases across environments.</CardDescription>
                </CardHeader>
                <CardContent>
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Test Name</TableHead>
                                <TableHead>Environment</TableHead>
                                <TableHead>Steps</TableHead>
                                <TableHead>Priority</TableHead>
                                <TableHead>Created</TableHead>
                                <TableHead className="text-right">Actions</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {isLoading ? (
                                <TableRow>
                                    <TableCell colSpan={6} className="text-center py-10">
                                        <Loader2 className="h-8 w-8 animate-spin mx-auto text-muted-foreground" />
                                    </TableCell>
                                </TableRow>
                            ) : tests.length === 0 ? (
                                <TableRow>
                                    <TableCell colSpan={6} className="text-center">
                                        <div className="empty-state">
                                            <FileText className="empty-state-icon" />
                                            <p className="empty-state-title">No tests found</p>
                                            <p className="empty-state-message">Create your first test case to get started.</p>
                                            <Button variant="outline" size="sm" asChild className="mt-4">
                                                <Link href="/dashboard/tests/create">Create your first test</Link>
                                            </Button>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ) : tests.map((test) => (
                                <TableRow
                                    key={test.id}
                                    className="group hover:bg-muted/50 cursor-pointer transition-colors"
                                    onClick={() => router.push(`/dashboard/tests/${test.id}`)}
                                >
                                    <TableCell className="font-medium">
                                        <div className="flex items-center gap-2">
                                            <FileText className="h-4 w-4 text-muted-foreground" />
                                            {test.name}
                                        </div>
                                    </TableCell>
                                    <TableCell>{test.project_name}</TableCell>
                                    <TableCell>{test.steps?.length || 0}</TableCell>
                                    <TableCell>
                                        <Badge
                                            variant="outline"
                                            className={`capitalize ${priorityStyles[test.priority?.toLowerCase()] ?? ""}`}
                                        >
                                            {test.priority}
                                        </Badge>
                                    </TableCell>
                                    <TableCell className="text-muted-foreground text-sm">
                                        {format(new Date(test.created_at), "MMM d, yyyy")}
                                    </TableCell>
                                    <TableCell className="text-right">
                                        <div className="flex items-center justify-end gap-2">
                                            <Link
                                                href={`/dashboard/tests/${test.id}`}
                                                onClick={(e) => e.stopPropagation()}
                                            >
                                                <button
                                                    className="opacity-0 group-hover:opacity-100 transition-opacity duration-150
                                                               px-2 py-1 text-xs rounded
                                                               bg-transparent hover:bg-blue-50
                                                               text-blue-600 border border-blue-200"
                                                >
                                                    <Edit className="inline h-3 w-3 mr-1" />
                                                    Edit
                                                </button>
                                            </Link>
                                            <button
                                                className="opacity-0 group-hover:opacity-100 transition-opacity duration-150
                                                           px-2 py-1 text-xs rounded
                                                           bg-transparent hover:bg-red-50
                                                           text-red-600 border border-red-200"
                                                onClick={(e) => handleDeleteTest(e, test.id)}
                                            >
                                                <Trash2 className="inline h-3 w-3 mr-1" />
                                                Delete
                                            </button>
                                            <DropdownMenu>
                                                <DropdownMenuTrigger asChild>
                                                    <Button
                                                        variant="ghost"
                                                        className="h-8 w-8 p-0"
                                                        onClick={(e) => e.stopPropagation()}
                                                    >
                                                        <span className="sr-only">Open menu</span>
                                                        <MoreVertical className="h-4 w-4" />
                                                    </Button>
                                                </DropdownMenuTrigger>
                                                <DropdownMenuContent align="end">
                                                    <DropdownMenuLabel>Actions</DropdownMenuLabel>
                                                    <DropdownMenuItem asChild>
                                                        <Link href={`/dashboard/tests/${test.id}`} className="cursor-pointer">
                                                            <Edit className="mr-2 h-4 w-4" /> Edit
                                                        </Link>
                                                    </DropdownMenuItem>
                                                    <DropdownMenuItem onClick={() => handleRunTest(test.id)}>
                                                        <Play className="mr-2 h-4 w-4" /> Run
                                                    </DropdownMenuItem>
                                                    <DropdownMenuSeparator />
                                                    <DropdownMenuItem
                                                        className="text-red-500 cursor-pointer"
                                                        onClick={(e) => handleDeleteTest(e as any, test.id)}
                                                    >
                                                        Delete
                                                    </DropdownMenuItem>
                                                </DropdownMenuContent>
                                            </DropdownMenu>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </div>
    )
}
