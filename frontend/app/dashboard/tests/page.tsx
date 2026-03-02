"use client"

import Link from "next/link"
import { Plus, Search, Play, Edit, MoreVertical, FileText, Loader2 } from "lucide-react"

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

export default function TestsPage() {
    const [tests, setTests] = useState<TestCase[]>([])
    const [isLoading, setIsLoading] = useState(true)

    const fetchTests = async () => {
        setIsLoading(true)
        try {
            const response = await fetch("http://localhost:8000/api/v1/tests")
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
            const response = await fetch("http://localhost:8000/api/v1/test-runs", {
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

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight">Test Cases</h2>
                    <p className="text-muted-foreground">Manage and execute your automated test scenarios.</p>
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
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input type="search" placeholder="Search tests..." className="pl-8" />
                </div>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle>All Tests</CardTitle>
                    <CardDescription>List of all test cases across projects.</CardDescription>
                </CardHeader>
                <CardContent>
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Test Name</TableHead>
                                <TableHead>Project</TableHead>
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
                                    <TableCell colSpan={6} className="text-center py-10 text-muted-foreground">
                                        <div className="flex flex-col items-center justify-center space-y-3">
                                            <FileText className="h-10 w-10 text-muted-foreground/50" />
                                            <p>No tests found.</p>
                                            <Button variant="outline" size="sm" asChild>
                                                <Link href="/dashboard/tests/create">Create your first test</Link>
                                            </Button>
                                        </div>
                                    </TableCell>
                                </TableRow>
                            ) : tests.map((test) => (
                                <TableRow key={test.id}>
                                    <TableCell className="font-medium">
                                        <div className="flex items-center gap-2">
                                            <FileText className="h-4 w-4 text-muted-foreground" />
                                            {test.name}
                                        </div>
                                    </TableCell>
                                    <TableCell>{test.project_name}</TableCell>
                                    <TableCell>{test.steps?.length || 0}</TableCell>
                                    <TableCell>
                                        <Badge variant="outline" className="capitalize">
                                            {test.priority}
                                        </Badge>
                                    </TableCell>
                                    <TableCell className="text-muted-foreground text-sm">
                                        {format(new Date(test.created_at), "MMM d, yyyy")}
                                    </TableCell>
                                    <TableCell className="text-right">
                                        <DropdownMenu>
                                            <DropdownMenuTrigger asChild>
                                                <Button variant="ghost" className="h-8 w-8 p-0">
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
                                                <DropdownMenuItem className="text-red-500">Delete</DropdownMenuItem>
                                            </DropdownMenuContent>
                                        </DropdownMenu>
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
