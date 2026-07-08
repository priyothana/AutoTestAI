"use client"

import { use, useState, useEffect } from "react"
import { usePathname } from "next/navigation"
import Link from "next/link"
import {
    LogOut,
    Menu,
    Bell,
    User,
    CreditCard,
    Users,
    Settings
} from "lucide-react"
import ThemeToggle from "@/components/shared/ThemeToggle"
import Logo from "@/components/shared/Logo"
import Sidebar from "@/components/shared/Sidebar"

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

export default function DashboardLayout({ children, params }: DashboardLayoutProps) {
    use(params)
    const pathname = usePathname()
    const [mounted, setMounted] = useState(false)
    const [user, setUser] = useState<{ username: string; email: string; full_name?: string; avatar_url?: string } | null>(null)

    const handleLogout = async () => {
        if (typeof window !== "undefined") {
            try {
                const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000"
                await fetch(`${API}/api/auth/logout`, { 
                    method: "POST", 
                    credentials: "include" 
                })
            } catch (err) {
                console.error("Logout API failed:", err)
            } finally {
                localStorage.removeItem("token")
                window.location.href = "/login"
            }
        }
    }

    useEffect(() => {
        setMounted(true)
        
        // 1. Immediately parse local storage token to prevent header layout delay
        const token = localStorage.getItem("token")
        if (token) {
            try {
                const payload = JSON.parse(atob(token.split('.')[1]))
                setUser({
                    username: payload.username,
                    email: payload.email,
                    full_name: payload.full_name || payload.username,
                    avatar_url: payload.avatar_url,
                })
            } catch (e) {
                console.error("Failed to parse local JWT token:", e)
            }
        }

        // 2. Fetch fresh profile from API to ensure session is active
        const fetchUser = async () => {
            try {
                const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000"
                const res = await fetch(`${API}/api/auth/me`)
                if (res.ok) {
                    const data = await res.json()
                    setUser(data)
                } else if (res.status === 401) {
                    handleLogout()
                }
            } catch (e) {
                console.error("Failed to fetch fresh user details:", e)
            }
        }

        fetchUser()
    }, [])

    const initials = user?.username 
        ? user.username.substring(0, 2).toUpperCase() 
        : (user?.email ? user.email.substring(0, 2).toUpperCase() : "US")

    return (
        <div className="flex min-h-screen" style={{ backgroundColor: 'var(--color-bg-base)' }}>
            {/* Desktop Sidebar */}
            <aside className="hidden md:block flex-shrink-0">
                <Sidebar pathname={pathname} />
            </aside>

            <div className="flex flex-1 flex-col overflow-auto">
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
                                <SheetContent side="left" className="w-[280px] p-0" style={{ backgroundColor: 'transparent', border: 'none' }}>
                                    <Sidebar pathname={pathname} mobile />
                                </SheetContent>
                            </Sheet>
                        ) : (
                            <Button variant="ghost" size="icon" className="md:hidden">
                                <Menu className="h-5 w-5" />
                                <span className="sr-only">Toggle menu</span>
                            </Button>
                        )}
                        <span className="md:hidden"><Logo size="sm" /></span>
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
                                            {user?.avatar_url && <AvatarImage src={user.avatar_url} alt={user.full_name || user.username} />}
                                            <AvatarFallback>{initials}</AvatarFallback>
                                        </Avatar>
                                    </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-56">
                                    <DropdownMenuLabel className="font-normal">
                                        <div className="flex flex-col space-y-1">
                                            <p className="text-sm font-medium leading-none">
                                                {user?.full_name || user?.username || "User"}
                                            </p>
                                            <p className="text-xs leading-none text-muted-foreground">
                                                {user?.email || ""}
                                            </p>
                                        </div>
                                    </DropdownMenuLabel>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem asChild>
                                        <Link href="/dashboard/profile" className="flex items-center w-full cursor-pointer">
                                            <User className="mr-2 h-4 w-4" />
                                            <span>My Profile</span>
                                        </Link>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem asChild>
                                        <Link href="/dashboard/billing" className="flex items-center w-full cursor-pointer">
                                            <CreditCard className="mr-2 h-4 w-4" />
                                            <span>Billing & Plans</span>
                                        </Link>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem asChild>
                                        <Link href="/dashboard/team" className="flex items-center w-full cursor-pointer">
                                            <Users className="mr-2 h-4 w-4" />
                                            <span>Team Members</span>
                                        </Link>
                                    </DropdownMenuItem>
                                    <DropdownMenuItem asChild>
                                        <Link href="/dashboard/settings" className="flex items-center w-full cursor-pointer">
                                            <Settings className="mr-2 h-4 w-4" />
                                            <span>App Settings</span>
                                        </Link>
                                    </DropdownMenuItem>
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
                                    <AvatarFallback>US</AvatarFallback>
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
