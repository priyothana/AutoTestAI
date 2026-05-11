"use client"

import { useState, useEffect } from "react"
import { CheckCircle2, Play, AlertCircle, Loader2, FileText, BarChart2, TrendingUp, Activity, Zap, ArrowUpRight, Clock } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from "recharts"
import { formatDistanceToNow } from "date-fns"

export default function DashboardPage() {
    const [stats, setStats] = useState({ total_projects: 0, total_test_cases: 0, total_executions: 0, pass_rate: 0 })
    const [distribution, setDistribution] = useState<{ name: string, value: number, color: string }[]>([])
    const [recentRuns, setRecentRuns] = useState<any[]>([])
    const [isLoadingData, setIsLoadingData] = useState(true)
    const [animateCards, setAnimateCards] = useState(false)

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

        const fetchDashboardData = async () => {
            setIsLoadingData(true)
            try {
                const [statsRes, distRes, runsRes] = await Promise.all([
                    safeFetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/analytics/dashboard-stats`),
                    safeFetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/analytics/execution-distribution`),
                    safeFetch(`${process.env.NEXT_PUBLIC_API_URL}/api/v1/test-runs/?limit=10`)
                ])

                if (statsRes?.ok) setStats(await statsRes.json())

                if (distRes?.ok) {
                    const distData = await distRes.json()
                    const formattedDist = distData.map((d: any) => ({
                        name: d.result.charAt(0).toUpperCase() + d.result.slice(1),
                        value: d.count,
                        color: d.result === 'passed' ? '#22c55e' : d.result === 'error' || d.result === 'failed' ? '#ef4444' : d.result === 'running' ? '#6b6bff' : '#f59e0b'
                    }))
                    setDistribution(formattedDist)
                }

                if (runsRes?.ok) setRecentRuns(await runsRes.json())

            } catch (error) {
                console.error("Failed to fetch dashboard data:", error)
            } finally {
                setIsLoadingData(false)
                setTimeout(() => setAnimateCards(true), 100)
            }
        }

        fetchDashboardData()
    }, [])

    const statCards = [
        {
            label: "Total Environments",
            value: stats.total_projects,
            icon: FolderIcon,
            gradient: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
            lightBg: "rgba(102, 126, 234, 0.08)",
            iconColor: "#667eea",
            accentColor: "#667eea",
            trend: "+2 this month",
            trendPositive: true,
        },
        {
            label: "Total Test Cases",
            value: stats.total_test_cases,
            icon: FileText,
            gradient: "linear-gradient(135deg, #6b6bff 0%, #a78bfa 100%)",
            lightBg: "rgba(107, 107, 255, 0.08)",
            iconColor: "#6b6bff",
            accentColor: "#6b6bff",
            trend: "+12 this week",
            trendPositive: true,
        },
        {
            label: "Total Executions",
            value: stats.total_executions,
            icon: Play,
            gradient: "linear-gradient(135deg, #3b82f6 0%, #06b6d4 100%)",
            lightBg: "rgba(59, 130, 246, 0.08)",
            iconColor: "#3b82f6",
            accentColor: "#3b82f6",
            trend: "Last run 3h ago",
            trendPositive: true,
        },
        {
            label: "Pass Rate",
            value: `${stats.pass_rate}%`,
            icon: TrendingUp,
            gradient: "linear-gradient(135deg, #22c55e 0%, #10b981 100%)",
            lightBg: "rgba(34, 197, 94, 0.08)",
            iconColor: "#22c55e",
            accentColor: "#22c55e",
            trend: stats.pass_rate >= 70 ? "Above target" : "Below target",
            trendPositive: stats.pass_rate >= 70,
        },
    ]

    return (
        <div className="space-y-8">
            {/* ── Page Header ── */}
            <div className="flex items-start justify-between">
                <div>
                    <div className="flex items-center gap-3 mb-1">
                        <div
                            className="p-2 rounded-xl"
                            style={{ background: "linear-gradient(135deg, #6b6bff22, #a78bfa22)", border: "1px solid rgba(107, 107, 255, 0.2)" }}
                        >
                            <Activity className="h-5 w-5" style={{ color: "var(--color-brand)" }} />
                        </div>
                        <h1 className="page-title" style={{ fontSize: "26px", fontWeight: 700 }}>Dashboard</h1>
                    </div>
                    <p className="page-subtitle" style={{ marginLeft: "44px" }}>
                        Overview of your testing activity and reports.
                    </p>
                </div>
                <div
                    className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium"
                    style={{
                        background: "var(--color-success-light)",
                        color: "var(--color-success)",
                        border: "1px solid rgba(34, 197, 94, 0.2)",
                    }}
                >
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                    Live
                </div>
            </div>

            {/* ── Stat Cards ── */}
            <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-4">
                {statCards.map((card, i) => (
                    <StatCard key={card.label} card={card} index={i} isLoading={isLoadingData} animate={animateCards} />
                ))}
            </div>

            {/* ── Charts + Recent Activity ── */}
            <div className="grid gap-5 lg:grid-cols-7">
                {/* Execution Distribution */}
                <div
                    className="lg:col-span-4 rounded-2xl overflow-hidden"
                    style={{
                        background: "var(--color-bg-elevated)",
                        border: "1px solid var(--color-border-sem)",
                        boxShadow: "var(--shadow-md)",
                    }}
                >
                    {/* Card Header */}
                    <div
                        className="flex items-center justify-between px-6 py-4"
                        style={{ borderBottom: "1px solid var(--color-border-sem)" }}
                    >
                        <div className="flex items-center gap-3">
                            <div
                                className="p-2 rounded-lg"
                                style={{ background: "rgba(107, 107, 255, 0.1)" }}
                            >
                                <BarChart2 className="h-4 w-4" style={{ color: "var(--color-brand)" }} />
                            </div>
                            <div>
                                <h3 className="font-semibold text-sm" style={{ color: "var(--color-text-primary)" }}>
                                    Execution Status
                                </h3>
                                <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                                    Distribution of all test runs
                                </p>
                            </div>
                        </div>
                        {!isLoadingData && distribution.length > 0 && (
                            <span
                                className="text-xs font-medium px-2.5 py-1 rounded-full"
                                style={{ background: "var(--color-brand-light)", color: "var(--color-brand)" }}
                            >
                                {distribution.reduce((acc, d) => acc + d.value, 0)} total
                            </span>
                        )}
                    </div>

                    {/* Chart Body */}
                    <div className="p-6">
                        <div className="h-[260px] flex items-center justify-center">
                            {isLoadingData ? (
                                <div className="flex flex-col items-center gap-3">
                                    <Loader2 className="h-8 w-8 animate-spin" style={{ color: "var(--color-brand)" }} />
                                    <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>Loading data...</span>
                                </div>
                            ) : distribution.length > 0 ? (
                                <ResponsiveContainer width="100%" height="100%">
                                    <PieChart>
                                        <Pie
                                            data={distribution}
                                            cx="50%"
                                            cy="45%"
                                            innerRadius={70}
                                            outerRadius={100}
                                            paddingAngle={4}
                                            dataKey="value"
                                            strokeWidth={0}
                                        >
                                            {distribution.map((entry, index) => (
                                                <Cell key={`cell-${index}`} fill={entry.color} />
                                            ))}
                                        </Pie>
                                        <Tooltip
                                            contentStyle={{
                                                backgroundColor: "var(--color-bg-elevated)",
                                                border: "1px solid var(--color-border-sem)",
                                                borderRadius: "10px",
                                                boxShadow: "var(--shadow-lg)",
                                                color: "var(--color-text-primary)",
                                                fontSize: "13px",
                                                padding: "10px 14px",
                                            }}
                                            itemStyle={{ color: "var(--color-text-secondary)" }}
                                            labelStyle={{ color: "var(--color-text-primary)", fontWeight: 600 }}
                                        />
                                        <Legend
                                            verticalAlign="bottom"
                                            height={36}
                                            formatter={(value) => (
                                                <span style={{ color: "var(--color-text-secondary)", fontSize: "12px" }}>{value}</span>
                                            )}
                                        />
                                    </PieChart>
                                </ResponsiveContainer>
                            ) : (
                                <div className="flex flex-col items-center gap-3 text-center">
                                    <div
                                        className="p-4 rounded-2xl"
                                        style={{ background: "var(--color-bg-overlay)" }}
                                    >
                                        <BarChart2 className="h-8 w-8" style={{ color: "var(--color-text-muted)", opacity: 0.4 }} />
                                    </div>
                                    <p className="text-sm font-medium" style={{ color: "var(--color-text-secondary)" }}>
                                        No execution data yet
                                    </p>
                                    <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                                        Run tests to see the distribution
                                    </p>
                                </div>
                            )}
                        </div>

                        {/* Distribution Breakdown Bars */}
                        {!isLoadingData && distribution.length > 0 && (
                            <div className="mt-4 space-y-2.5">
                                {distribution.map((d) => {
                                    const total = distribution.reduce((acc, x) => acc + x.value, 0)
                                    const pct = total > 0 ? Math.round((d.value / total) * 100) : 0
                                    return (
                                        <div key={d.name} className="flex items-center gap-3">
                                            <span className="text-xs w-16 text-right" style={{ color: "var(--color-text-muted)" }}>
                                                {d.name}
                                            </span>
                                            <div
                                                className="flex-1 h-1.5 rounded-full overflow-hidden"
                                                style={{ background: "var(--color-bg-overlay)" }}
                                            >
                                                <div
                                                    className="h-full rounded-full transition-all duration-700"
                                                    style={{ width: `${pct}%`, background: d.color }}
                                                />
                                            </div>
                                            <span className="text-xs font-semibold w-8" style={{ color: d.color }}>
                                                {pct}%
                                            </span>
                                        </div>
                                    )
                                })}
                            </div>
                        )}
                    </div>
                </div>

                {/* Recent Activity */}
                <div
                    className="lg:col-span-3 rounded-2xl overflow-hidden flex flex-col"
                    style={{
                        background: "var(--color-bg-elevated)",
                        border: "1px solid var(--color-border-sem)",
                        boxShadow: "var(--shadow-md)",
                    }}
                >
                    {/* Card Header */}
                    <div
                        className="flex items-center justify-between px-6 py-4"
                        style={{ borderBottom: "1px solid var(--color-border-sem)" }}
                    >
                        <div className="flex items-center gap-3">
                            <div
                                className="p-2 rounded-lg"
                                style={{ background: "rgba(59, 130, 246, 0.1)" }}
                            >
                                <Clock className="h-4 w-4" style={{ color: "var(--color-info)" }} />
                            </div>
                            <div>
                                <h3 className="font-semibold text-sm" style={{ color: "var(--color-text-primary)" }}>
                                    Recent Activity
                                </h3>
                                <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                                    Latest test runs and executions
                                </p>
                            </div>
                        </div>
                        {!isLoadingData && recentRuns.length > 0 && (
                            <span
                                className="text-xs font-medium px-2.5 py-1 rounded-full"
                                style={{ background: "var(--color-info-light)", color: "var(--color-info)" }}
                            >
                                {recentRuns.length} runs
                            </span>
                        )}
                    </div>

                    {/* Activity List */}
                    <div className="flex-1 overflow-y-auto p-4 space-y-2">
                        {isLoadingData ? (
                            <div className="flex justify-center items-center py-10 gap-3 flex-col">
                                <Loader2 className="h-6 w-6 animate-spin" style={{ color: "var(--color-brand)" }} />
                                <span className="text-xs" style={{ color: "var(--color-text-muted)" }}>Loading activity...</span>
                            </div>
                        ) : recentRuns.length === 0 ? (
                            <div className="flex flex-col items-center justify-center py-10 gap-3">
                                <div
                                    className="p-4 rounded-2xl"
                                    style={{ background: "var(--color-bg-overlay)" }}
                                >
                                    <Zap className="h-7 w-7" style={{ color: "var(--color-text-muted)", opacity: 0.4 }} />
                                </div>
                                <p className="text-sm font-medium" style={{ color: "var(--color-text-secondary)" }}>
                                    No recent test runs
                                </p>
                                <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                                    Execute a test case to get started 🚀
                                </p>
                            </div>
                        ) : (
                            recentRuns.slice(0, 8).map((run, idx) => {
                                const isRunning = run.status === "running"
                                const isPassed = run.result === "passed"
                                const isFailed = !isRunning && !isPassed

                                const config = isRunning
                                    ? { iconBg: "rgba(59, 130, 246, 0.1)", iconColor: "#3b82f6", Icon: Play, label: run.status }
                                    : isPassed
                                    ? { iconBg: "rgba(34, 197, 94, 0.1)", iconColor: "#22c55e", Icon: CheckCircle2, label: run.result }
                                    : { iconBg: "rgba(239, 68, 68, 0.1)", iconColor: "#ef4444", Icon: AlertCircle, label: run.result || run.status }

                                return (
                                    <div
                                        key={run.id}
                                        className="flex items-center gap-3 p-3 rounded-xl transition-all"
                                        style={{
                                            background: "transparent",
                                            border: "1px solid transparent",
                                            cursor: "default",
                                        }}
                                        onMouseEnter={(e) => {
                                            (e.currentTarget as HTMLElement).style.background = "var(--color-bg-overlay)"
                                            ;(e.currentTarget as HTMLElement).style.borderColor = "var(--color-border-sem)"
                                        }}
                                        onMouseLeave={(e) => {
                                            (e.currentTarget as HTMLElement).style.background = "transparent"
                                            ;(e.currentTarget as HTMLElement).style.borderColor = "transparent"
                                        }}
                                    >
                                        <div
                                            className={`p-2 rounded-lg flex-shrink-0${isRunning ? " animate-pulse" : ""}`}
                                            style={{ background: config.iconBg }}
                                        >
                                            <config.Icon className="h-3.5 w-3.5" style={{ color: config.iconColor }} />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <p
                                                className="text-sm font-medium truncate leading-tight"
                                                style={{ color: "var(--color-text-primary)" }}
                                            >
                                                {run.test_case_name || "Test Case"}
                                            </p>
                                            <p className="text-xs mt-0.5" style={{ color: "var(--color-text-muted)" }}>
                                                {formatDistanceToNow(new Date(run.created_at), { addSuffix: true })}
                                            </p>
                                        </div>
                                        <span
                                            className="text-[10px] font-semibold px-2 py-0.5 rounded-full capitalize flex-shrink-0"
                                            style={{
                                                background: config.iconBg,
                                                color: config.iconColor,
                                            }}
                                        >
                                            {config.label}
                                        </span>
                                    </div>
                                )
                            })
                        )}
                    </div>
                </div>
            </div>

            {/* ── Quick Stats Row ── */}
            {!isLoadingData && (
                <div className="grid gap-4 md:grid-cols-3">
                    <QuickStatCard
                        label="Success Rate Trend"
                        value={`${stats.pass_rate}%`}
                        description="Based on total executions"
                        color={stats.pass_rate >= 70 ? "#22c55e" : stats.pass_rate >= 40 ? "#f59e0b" : "#ef4444"}
                        percentage={stats.pass_rate}
                    />
                    <QuickStatCard
                        label="Avg Tests per Environment"
                        value={stats.total_projects > 0 ? Math.round(stats.total_test_cases / stats.total_projects).toString() : "—"}
                        description="Test cases distributed across envs"
                        color="#6b6bff"
                        percentage={Math.min((stats.total_test_cases / Math.max(stats.total_projects * 20, 1)) * 100, 100)}
                    />
                    <QuickStatCard
                        label="Execution Coverage"
                        value={stats.total_test_cases > 0 ? `${Math.round((stats.total_executions / stats.total_test_cases) * 100)}%` : "—"}
                        description="Tests executed vs total tests"
                        color="#3b82f6"
                        percentage={Math.min(stats.total_test_cases > 0 ? (stats.total_executions / stats.total_test_cases) * 100 : 0, 100)}
                    />
                </div>
            )}
        </div>
    )
}

/* ─────────────────────────────────────── */
/*  Sub-components                         */
/* ─────────────────────────────────────── */

function StatCard({
    card,
    index,
    isLoading,
    animate,
}: {
    card: any
    index: number
    isLoading: boolean
    animate: boolean
}) {
    return (
        <div
            className="relative rounded-2xl overflow-hidden group"
            style={{
                background: "var(--color-bg-elevated)",
                border: "1px solid var(--color-border-sem)",
                boxShadow: "var(--shadow-md)",
                transition: "transform 200ms ease, box-shadow 200ms ease",
                opacity: animate ? 1 : 0,
                transform: animate ? "translateY(0)" : "translateY(12px)",
                transitionDelay: `${index * 60}ms`,
            }}
            onMouseEnter={(e) => {
                const el = e.currentTarget as HTMLElement
                el.style.transform = "translateY(-3px)"
                el.style.boxShadow = "0 12px 28px rgba(0,0,0,0.12)"
            }}
            onMouseLeave={(e) => {
                const el = e.currentTarget as HTMLElement
                el.style.transform = "translateY(0)"
                el.style.boxShadow = "var(--shadow-md)"
            }}
        >
            {/* Gradient accent strip at top */}
            <div
                className="h-1 w-full"
                style={{ background: card.gradient }}
            />

            <div className="p-5">
                <div className="flex items-start justify-between mb-4">
                    <div>
                        <p className="text-xs font-medium uppercase tracking-wide mb-1" style={{ color: "var(--color-text-muted)" }}>
                            {card.label}
                        </p>
                        <div
                            className="text-3xl font-bold"
                            style={{
                                color: "var(--color-text-primary)",
                                letterSpacing: "-0.03em",
                                lineHeight: 1,
                            }}
                        >
                            {isLoading ? (
                                <Loader2 className="h-6 w-6 animate-spin mt-1" style={{ color: "var(--color-text-muted)" }} />
                            ) : (
                                card.value
                            )}
                        </div>
                    </div>

                    {/* Icon circle */}
                    <div
                        className="p-3 rounded-xl flex-shrink-0"
                        style={{
                            background: card.lightBg,
                            border: `1px solid ${card.accentColor}22`,
                        }}
                    >
                        <card.icon className="h-5 w-5" style={{ color: card.accentColor }} />
                    </div>
                </div>

                {/* Trend row */}
                <div className="flex items-center gap-1.5 mt-2">
                    <ArrowUpRight
                        className="h-3 w-3"
                        style={{ color: card.trendPositive ? "#22c55e" : "#f59e0b" }}
                    />
                    <span
                        className="text-[11px] font-medium"
                        style={{ color: card.trendPositive ? "var(--color-success)" : "var(--color-warning)" }}
                    >
                        {card.trend}
                    </span>
                </div>
            </div>
        </div>
    )
}

function QuickStatCard({
    label,
    value,
    description,
    color,
    percentage,
}: {
    label: string
    value: string
    description: string
    color: string
    percentage: number
}) {
    return (
        <div
            className="rounded-2xl p-5"
            style={{
                background: "var(--color-bg-elevated)",
                border: "1px solid var(--color-border-sem)",
                boxShadow: "var(--shadow-sm)",
            }}
        >
            <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: "var(--color-text-muted)" }}>
                    {label}
                </p>
                <span className="text-lg font-bold" style={{ color }}>
                    {value}
                </span>
            </div>
            {/* Progress bar */}
            <div
                className="h-2 rounded-full overflow-hidden mb-2"
                style={{ background: "var(--color-bg-overlay)" }}
            >
                <div
                    className="h-full rounded-full transition-all duration-700"
                    style={{ width: `${Math.min(percentage, 100)}%`, background: color }}
                />
            </div>
            <p className="text-xs" style={{ color: "var(--color-text-muted)" }}>
                {description}
            </p>
        </div>
    )
}

function FolderIcon(props: any) {
    return (
        <svg
            {...props}
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
        </svg>
    )
}
