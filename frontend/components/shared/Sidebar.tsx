"use client"

import { useState, useEffect, useCallback } from "react"
import Link from "next/link"
import {
    LayoutDashboard,
    FolderKanban,
    TestTube2,
    PlayCircle,
    FileBarChart,
    Settings,
    PanelLeftClose,
    Sparkles,
} from "lucide-react"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import Logo from "@/components/shared/Logo"
import TestsIcon from "@/components/shared/TestsIcon"

/* ── Navigation Items ── */
const sidebarItems = [
    { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
    { name: "Environments", href: "/dashboard/projects", icon: FolderKanban },
    { name: "Tests", href: "/dashboard/tests", icon: TestTube2, customIcon: true },
    { name: "Execution", href: "/dashboard/execution", icon: PlayCircle },
    { name: "Reports", href: "/dashboard/reports", icon: FileBarChart },
    { name: "Settings", href: "/dashboard/settings", icon: Settings },
]

const STORAGE_KEY = "autotest-sidebar-collapsed"

interface SidebarProps {
    /** Current pathname for active state detection */
    pathname: string
    /** When true, renders in "mobile" mode — always expanded, no collapse toggle */
    mobile?: boolean
}

export default function Sidebar({ pathname, mobile = false }: SidebarProps) {
    const [collapsed, setCollapsed] = useState(false)
    const [mounted, setMounted] = useState(false)

    useEffect(() => {
        // Restore collapse state from localStorage (desktop only)
        if (!mobile) {
            const stored = localStorage.getItem(STORAGE_KEY)
            if (stored === "true") setCollapsed(true)
        }
        setMounted(true)
    }, [mobile])

    const toggleCollapse = useCallback(() => {
        setCollapsed(prev => {
            const next = !prev
            localStorage.setItem(STORAGE_KEY, String(next))
            return next
        })
    }, [])

    // In mobile mode, always expanded
    const isCollapsed = mobile ? false : collapsed

    const sidebarWidth = isCollapsed
        ? "var(--sidebar-width-collapsed)"
        : "var(--sidebar-width-expanded)"

    return (
        <div
            className="sidebar"
            style={{ width: mobile ? "100%" : sidebarWidth }}
            role="navigation"
            aria-label="Main navigation"
        >
            {/* ── Header ── */}
            <div className={`sidebar-header ${isCollapsed ? "sidebar-header--collapsed" : ""}`}>
                {isCollapsed ? (
                    <Link href="/dashboard" className="flex items-center" aria-label="Go to dashboard">
                        <Logo size="sm" showText={false} />
                    </Link>
                ) : (
                    <Link href="/dashboard" className="flex items-center">
                        <Logo size="sm" />
                    </Link>
                )}

                {/* Collapse toggle — desktop only */}
                {!mobile && mounted && (
                    <button
                        className={`sidebar-collapse-btn ${isCollapsed ? "sidebar-collapse-btn--rotated" : ""}`}
                        onClick={toggleCollapse}
                        aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                        title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                    >
                        <PanelLeftClose className="h-4 w-4" />
                    </button>
                )}
            </div>

            {/* ── Section Label ── */}
            <div className={`sidebar-section-label ${isCollapsed ? "sidebar-section-label--collapsed" : ""}`}>
                {isCollapsed ? null : <span>Main</span>}
            </div>

            {/* ── Navigation Items ── */}
            <nav className="flex flex-col gap-0.5 px-0">
                {sidebarItems.map((item) => {
                    const isActive =
                        item.href === "/dashboard"
                            ? pathname === item.href
                            : pathname === item.href || pathname.startsWith(item.href + "/")

                    const navLink = (
                        <Link
                            key={item.href}
                            href={item.href}
                            className={[
                                "sidebar-nav-item",
                                isActive ? "sidebar-nav-item--active" : "",
                                isCollapsed ? "sidebar-nav-item--collapsed" : "",
                            ].join(" ")}
                            aria-current={isActive ? "page" : undefined}
                        >
                            {item.customIcon ? (
                                <TestsIcon
                                    className="sidebar-nav-icon"
                                    active={isActive}
                                />
                            ) : (
                                <item.icon className="sidebar-nav-icon" />
                            )}
                            <span className={`sidebar-nav-label ${isCollapsed ? "sidebar-nav-label--hidden" : ""}`}>
                                {item.name}
                            </span>
                        </Link>
                    )

                    // Wrap with Tooltip when collapsed (desktop) for accessibility
                    if (isCollapsed) {
                        return (
                            <Tooltip key={item.href}>
                                <TooltipTrigger asChild>
                                    {navLink}
                                </TooltipTrigger>
                                <TooltipContent side="right" sideOffset={8}>
                                    {item.name}
                                </TooltipContent>
                            </Tooltip>
                        )
                    }

                    return navLink
                })}
            </nav>

            {/* ── Footer / Branding ── */}
            <div className={`sidebar-footer ${isCollapsed ? "sidebar-footer--collapsed" : ""}`}>
                {isCollapsed ? (
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <span className="flex items-center justify-center">
                                <Sparkles
                                    className="h-4 w-4"
                                    style={{ color: "var(--color-brand)", opacity: 0.6 }}
                                />
                            </span>
                        </TooltipTrigger>
                        <TooltipContent side="right" sideOffset={8}>
                            AutoTest AI v1.0
                        </TooltipContent>
                    </Tooltip>
                ) : (
                    <div className="sidebar-footer-brand">
                        <Sparkles
                            className="h-3.5 w-3.5 flex-shrink-0"
                            style={{ color: "var(--color-brand)", opacity: 0.6 }}
                        />
                        <span className="sidebar-footer-brand-text">
                            AutoTest AI
                        </span>
                        <span className="sidebar-footer-version">v1.0</span>
                    </div>
                )}
            </div>
        </div>
    )
}
