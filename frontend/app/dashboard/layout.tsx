"use client"

import { use, useState, useEffect } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
    LayoutDashboard,
    FolderKanban,
    TestTube2,
    PlayCircle,
    FileBarChart,
    Settings,
    LogOut,
    Menu,
    Bell
} from "lucide-react"
import ThemeToggle from "@/components/shared/ThemeToggle"

import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger
} from "@/components/ui/dropdown-menu"

interface DashboardLayoutProps {
    children: React.ReactNode
    params: Promise<any>
}

const sidebarItems = [
    { name: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
    { name: "Environments", href: "/dashboard/projects", icon: FolderKanban },
    { name: "Tests", href: "/dashboard/tests", icon: TestTube2 },
    { name: "Execution", href: "/dashboard/execution", icon: PlayCircle },
    { name: "Reports", href: "/dashboard/reports", icon: FileBarChart },
    { name: "Settings", href: "/dashboard/settings", icon: Settings },
]

export default function DashboardLayout({ children, params }: DashboardLayoutProps) {
    use(params)
    const pathname = usePathname()
    const [mounted, setMounted] = useState(false)

    useEffect(() => {
        setMounted(true)
    }, [])

    const handleLogout = () => {
        if (typeof window !== "undefined") {
            localStorage.removeItem("token")
            window.location.href = "/"
        }
    }

    return (
        <div className="flex min-h-screen" style={{ backgroundColor: 'var(--color-bg-base)' }}>
            {/* Desktop Sidebar */}
            <aside className="hidden w-64 md:block z-10" style={{ backgroundColor: 'var(--color-bg-elevated)', borderRight: '1px solid var(--color-border-sem)', boxShadow: 'var(--shadow-md)' }}>
                <div className="flex h-16 items-center px-6" style={{ borderBottom: '1px solid var(--color-border-sem)' }}>
                    <Link href="/dashboard" className="flex items-center gap-2 font-bold text-xl" style={{ color: 'var(--color-text-primary)' }}>
                        <div className="flex items-center justify-center p-1.5 rounded-md" style={{ backgroundColor: 'var(--color-brand-light)' }}>
                            <TestTube2 className="h-5 w-5" style={{ color: 'var(--color-brand)' }} />
                        </div>
                        <span>AutoTest <span className="font-black" style={{ color: 'var(--color-brand)' }}>AI</span></span>
                    </Link>
                </div>

                <nav className="flex flex-col gap-1 px-3">
                    <div className="px-3 mb-2 mt-4 text-xs font-semibold uppercase" style={{ color: 'var(--color-text-muted)', letterSpacing: '0.08em' }}>Main</div>
                    {sidebarItems.map((item) => {
                        const isActive = pathname === item.href
                        return (
                            <Link
                                key={item.href}
                                href={item.href}
                                className="group flex items-center gap-3 rounded-md px-3 py-2.5 text-sm transition-all"
                                style={isActive ? {
                                    color: 'var(--color-brand)',
                                    backgroundColor: 'var(--color-brand-light)',
                                    borderLeft: '2px solid var(--color-brand)',
                                    paddingLeft: '10px',
                                    fontWeight: 500,
                                    transitionDuration: 'var(--transition-fast)',
                                } : {
                                    color: 'var(--color-text-secondary)',
                                    backgroundColor: 'transparent',
                                    borderLeft: '2px solid transparent',
                                    paddingLeft: '10px',
                                    fontWeight: 400,
                                    transitionDuration: 'var(--transition-fast)',
                                }}
                                onMouseEnter={e => {
                                    if (!isActive) {
                                        const el = e.currentTarget as HTMLAnchorElement
                                        el.style.color = 'var(--color-text-primary)'
                                        el.style.backgroundColor = 'var(--color-bg-overlay)'
                                    }
                                }}
                                onMouseLeave={e => {
                                    if (!isActive) {
                                        const el = e.currentTarget as HTMLAnchorElement
                                        el.style.color = 'var(--color-text-secondary)'
                                        el.style.backgroundColor = 'transparent'
                                    }
                                }}
                            >
                                <item.icon
                                    className="h-4 w-4 flex-shrink-0"
                                    style={{
                                        opacity: isActive ? 1 : 0.6,
                                        color: isActive ? 'var(--color-brand)' : 'currentColor',
                                        transition: 'opacity var(--transition-fast), color var(--transition-fast)',
                                    }}
                                />
                                {item.name}
                            </Link>
                        )
                    })}
                </nav>
            </aside>

            <div className="flex flex-1 flex-col overflow-hidden">
                {/* Header */}
                <header className="flex h-16 items-center justify-between px-6 sticky top-0 z-20 backdrop-blur-md" style={{ backgroundColor: 'color-mix(in srgb, var(--color-bg-elevated) 85%, transparent)', borderBottom: '1px solid var(--color-border-sem)' }}>
                    <div className="flex items-center gap-4 md:hidden">
                        {mounted ? (
                            <Sheet>
                                <SheetTrigger asChild>
                                    <Button variant="ghost" size="icon" className="md:hidden">
                                        <Menu className="h-5 w-5" />
                                        <span className="sr-only">Toggle menu</span>
                                    </Button>
                                </SheetTrigger>
                                <SheetContent side="left" className="w-64 p-0" style={{ backgroundColor: 'var(--color-bg-elevated)', borderRight: '1px solid var(--color-border-sem)' }}>
                                    <div className="flex h-16 items-center px-6" style={{ borderBottom: '1px solid var(--color-border-sem)' }}>
                                        <span className="text-lg font-bold" style={{ color: 'var(--color-text-primary)' }}>AutoTest AI</span>
                                    </div>
                                    <nav className="flex flex-col gap-1 p-4">
                                        {sidebarItems.map((item) => {
                                            const isActiveMobile = pathname === item.href
                                            return (
                                            <Link
                                                key={item.href}
                                                href={item.href}
                                                className="flex items-center gap-3 rounded-md py-2 text-sm"
                                                style={isActiveMobile ? {
                                                    color: 'var(--color-brand)',
                                                    backgroundColor: 'var(--color-brand-light)',
                                                    borderLeft: '2px solid var(--color-brand)',
                                                    paddingLeft: '10px',
                                                    paddingRight: '12px',
                                                    fontWeight: 500,
                                                } : {
                                                    color: 'var(--color-text-secondary)',
                                                    borderLeft: '2px solid transparent',
                                                    paddingLeft: '10px',
                                                    paddingRight: '12px',
                                                }}
                                            >
                                                <item.icon
                                                    className="h-4 w-4 flex-shrink-0"
                                                    style={{
                                                        opacity: isActiveMobile ? 1 : 0.6,
                                                        color: isActiveMobile ? 'var(--color-brand)' : 'currentColor',
                                                    }}
                                                />
                                                {item.name}
                                            </Link>
                                        )})}
                                    </nav>
                                </SheetContent>
                            </Sheet>
                        ) : (
                            <Button variant="ghost" size="icon" className="md:hidden">
                                <Menu className="h-5 w-5" />
                                <span className="sr-only">Toggle menu</span>
                            </Button>
                        )}
                        <span className="font-semibold md:hidden">AutoTest AI</span>
                    </div>

                    <div className="flex flex-1 items-center justify-end gap-4">
                        <ThemeToggle />
                        <Button variant="ghost" size="icon">
                            <Bell className="h-5 w-5" />
                        </Button>
                        {mounted ? (
                            <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                    <Button variant="ghost" className="relative h-8 w-8 rounded-full">
                                        <Avatar className="h-8 w-8">
                                            <AvatarImage src="https://github.com/shadcn.png" alt="User" />
                                            <AvatarFallback>JD</AvatarFallback>
                                        </Avatar>
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                    <DropdownMenuLabel>My Account</DropdownMenuLabel>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem>Profile</DropdownMenuItem>
                                    <DropdownMenuItem>Billing</DropdownMenuItem>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                        style={{ color: 'var(--color-danger)' }}
                                        className="cursor-pointer"
                                        onClick={handleLogout}
                                    >
                                        <LogOut className="mr-2 h-4 w-4" />
                                        Log out
                                    </DropdownMenuItem>
                                </DropdownMenuContent>
                            </DropdownMenu>
                        ) : (
                            <Button variant="ghost" className="relative h-8 w-8 rounded-full">
                                <Avatar className="h-8 w-8">
                                    <AvatarImage src="https://github.com/shadcn.png" alt="User" />
                                    <AvatarFallback>JD</AvatarFallback>
                                </Avatar>
                            </Button>
                        )}
                    </div>
                </header>

                {/* Main Content */}
                <main className="flex-1 p-6 page-in">
                    {children}
                </main>
            </div>
        </div>
    )
}
