"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { BarChart3, CheckCircle2, XCircle, Filter, Download, Loader2, TrendingUp, AlertTriangle } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table"
import {
    LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, Legend, ResponsiveContainer
} from "recharts"

export default function ReportsPage() {
    const [isLoading, setIsLoading] = useState(true)
    const [trendData, setTrendData] = useState<any[]>([])
    const [projectSummary, setProjectSummary] = useState<any[]>([])
    const [topFailed, setTopFailed] = useState<any[]>([])

    // Quick stats derived from trendData (mocking last 7 days total for simplicity here, though actual DB might differ)
    const totalRuns = trendData.reduce((acc, curr) => acc + curr.passed + curr.failed, 0)
    const passedRuns = trendData.reduce((acc, curr) => acc + curr.passed, 0)
    const passRate = totalRuns > 0 ? Math.round((passedRuns / totalRuns) * 100) : 0

    useEffect(() => {
        const safeFetch = async (url: string): Promise<Response | null> => {
            try {
                const controller = new AbortController()
                const timeout = setTimeout(() => controller.abort(), 5000)
                const res = await fetch(url, { signal: controller.signal })
                clearTimeout(timeout)
                return res
            } catch {
                return null
            }
        }

        const fetchReportsData = async () => {
            setIsLoading(true)
            try {
                const [trendRes, projectRes, failedRes] = await Promise.all([
                    safeFetch("http://localhost:8000/api/v1/analytics/reports/trend"),
                    safeFetch("http://localhost:8000/api/v1/analytics/reports/projects"),
                    safeFetch("http://localhost:8000/api/v1/analytics/reports/top-failed")
                ])

                if (trendRes?.ok) {
                    const data = await trendRes.json()
                    const formattedData = data.map((d: any) => ({
                        ...d,
                        date: new Date(d.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                    }))
                    setTrendData(formattedData)
                }

                if (projectRes?.ok) setProjectSummary(await projectRes.json())
                if (failedRes?.ok) setTopFailed(await failedRes.json())
            } catch (error) {
                console.error("Failed to fetch reports data:", error)
            } finally {
                setIsLoading(false)
            }
        }

        fetchReportsData()
    }, [])
    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-3xl font-bold tracking-tight">Reports & Analytics</h2>
                    <p className="text-muted-foreground">Historical data and execution insights.</p>
                </div>
                <div className="flex gap-2">
                    <Button variant="outline">
                        <Filter className="mr-2 h-4 w-4" /> Filter
                    </Button>
                    <Button variant="outline">
                        <Download className="mr-2 h-4 w-4" /> Export CSV
                    </Button>
                </div>
            </div>

            <div className="grid gap-4 md:grid-cols-3">
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-muted-foreground">Runs (Last 7 Days)</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-2xl font-bold">
                            {isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : totalRuns}
                        </div>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-muted-foreground">Recent Pass Rate</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className={`text-2xl font-bold ${passRate >= 90 ? 'text-green-600' : passRate >= 75 ? 'text-amber-500' : 'text-red-600'}`}>
                            {isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : `${passRate}%`}
                        </div>
                    </CardContent>
                </Card>
                <Card>
                    <CardHeader className="pb-2">
                        <CardTitle className="text-sm font-medium text-muted-foreground">Most Critical Area</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-sm font-bold truncate">
                            {isLoading ? <Loader2 className="h-5 w-5 animate-spin" /> : topFailed.length > 0 ? topFailed[0].name : "None"}
                        </div>
                    </CardContent>
                </Card>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <TrendingUp className="h-4 w-4" />
                            Pass/Fail Trend (7 Days)
                        </CardTitle>
                        <CardDescription>Daily execution results overview</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="h-[300px] w-full">
                            {isLoading ? (
                                <div className="h-full flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
                            ) : trendData.length > 0 ? (
                                <ResponsiveContainer width="100%" height="100%">
                                    <LineChart data={trendData} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
                                        <XAxis dataKey="date" axisLine={false} tickLine={false} fontSize={12} tickMargin={10} />
                                        <YAxis axisLine={false} tickLine={false} fontSize={12} />
                                        <RechartsTooltip
                                            contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                                            cursor={{ stroke: '#E5E7EB', strokeWidth: 2 }}
                                        />
                                        <Legend iconType="circle" />
                                        <Line type="monotone" dataKey="passed" name="Passed" stroke="#22C55E" strokeWidth={3} dot={{ r: 4 }} activeDot={{ r: 6 }} />
                                        <Line type="monotone" dataKey="failed" name="Failed" stroke="#EF4444" strokeWidth={3} dot={{ r: 4 }} activeDot={{ r: 6 }} />
                                    </LineChart>
                                </ResponsiveContainer>
                            ) : (
                                <div className="h-full flex items-center justify-center text-muted-foreground">No trend data available</div>
                            )}
                        </div>
                    </CardContent>
                </Card>

                <Card>
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <BarChart3 className="h-4 w-4" />
                            Project Summaries
                        </CardTitle>
                        <CardDescription>Execution health by project area</CardDescription>
                    </CardHeader>
                    <CardContent>
                        <div className="h-[300px] w-full">
                            {isLoading ? (
                                <div className="h-full flex items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
                            ) : projectSummary.length > 0 ? (
                                <ResponsiveContainer width="100%" height="100%">
                                    <BarChart data={projectSummary} margin={{ top: 5, right: 20, bottom: 5, left: 0 }}>
                                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#E5E7EB" />
                                        <XAxis dataKey="project_name" axisLine={false} tickLine={false} fontSize={12} tickMargin={10} />
                                        <YAxis axisLine={false} tickLine={false} fontSize={12} />
                                        <RechartsTooltip
                                            cursor={{ fill: 'rgba(0,0,0,0.05)' }}
                                            contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)' }}
                                        />
                                        <Legend iconType="circle" />
                                        <Bar dataKey="passed" name="Passed" stackId="a" fill="#22C55E" radius={[0, 0, 4, 4]} />
                                        <Bar dataKey="failed" name="Failed" stackId="a" fill="#EF4444" radius={[4, 4, 0, 0]} />
                                    </BarChart>
                                </ResponsiveContainer>
                            ) : (
                                <div className="h-full flex items-center justify-center text-muted-foreground">No project data available</div>
                            )}
                        </div>
                    </CardContent>
                </Card>
            </div>

            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 text-red-600 dark:text-red-400">
                        <AlertTriangle className="h-5 w-5" />
                        Top Failing Test Cases
                    </CardTitle>
                    <CardDescription>Tests that require immediate attention</CardDescription>
                </CardHeader>
                <CardContent>
                    <Table>
                        <TableHeader>
                            <TableRow>
                                <TableHead>Test Case Name</TableHead>
                                <TableHead className="text-right">Failures</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {isLoading ? (
                                <TableRow>
                                    <TableCell colSpan={2} className="text-center py-6"><Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" /></TableCell>
                                </TableRow>
                            ) : topFailed.length > 0 ? (
                                topFailed.map((test, idx) => (
                                    <TableRow key={idx}>
                                        <TableCell className="font-medium">{test.name}</TableCell>
                                        <TableCell className="text-right">
                                            <Badge variant="destructive" className="ml-auto">{test.fail_count}</Badge>
                                        </TableCell>
                                    </TableRow>
                                ))
                            ) : (
                                <TableRow>
                                    <TableCell colSpan={2} className="text-center text-muted-foreground py-6">No failing tests found. Great job! 🎉</TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                </CardContent>
            </Card>
        </div>
    )
}
