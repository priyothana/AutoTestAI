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
    { name: "Projects", href: "/dashboard/projects", icon: FolderKanban },
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
        <div className="flex min-h-screen bg-slate-50 dark:bg-slate-950">
            {/* Desktop Sidebar */}
            <aside className="hidden w-64 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 md:block shadow-sm z-10">
                <div className="flex h-16 items-center border-b border-slate-100 dark:border-slate-800 px-6">
                    <Link href="/dashboard" className="flex items-center gap-2 font-bold text-xl text-slate-900 dark:text-white">
                        <div className="flex items-center justify-center p-1.5 bg-primary/10 rounded-md">
                            <TestTube2 className="h-5 w-5 text-primary" />
                        </div>
                        <span>AutoTest <span className="text-primary font-black">AI</span></span>
                    </Link>
                </div>

                <nav className="flex flex-col gap-1 px-3">
                    <div className="px-3 mb-2 mt-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Main</div>
                    {sidebarItems.map((item) => {
                        const isActive = pathname === item.href
                        return (
                            <Link
                                key={item.href}
                                href={item.href}
                                className={`flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-all ${isActive
                                    ? "bg-primary/10 text-primary dark:bg-primary/20 dark:text-indigo-400 font-semibold"
                                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800/60 dark:hover:text-slate-50"
                                    }`}
                            >
                                <item.icon className={`h-4 w-4 ${isActive ? 'text-primary dark:text-indigo-400' : 'text-slate-400'}`} />
                                {item.name}
                            </Link>
                        )
                    })}
                </nav>
            </aside>

            <div className="flex flex-1 flex-col overflow-hidden">
                {/* Header */}
                <header className="flex h-16 items-center justify-between border-b border-slate-200 dark:border-slate-800 bg-white/80 backdrop-blur-md px-6 dark:bg-slate-900/80 sticky top-0 z-20">
                    <div className="flex items-center gap-4 md:hidden">
                        {mounted ? (
                            <Sheet>
                                <SheetTrigger asChild>
                                    <Button variant="ghost" size="icon" className="md:hidden">
                                        <Menu className="h-5 w-5" />
                                        <span className="sr-only">Toggle menu</span>
                                    </Button>
                                </SheetTrigger>
                                <SheetContent side="left" className="w-64 p-0">
                                    <div className="flex h-16 items-center border-b px-6">
                                        <span className="text-lg font-bold">AutoTest AI</span>
                                    </div>
                                    <nav className="flex flex-col gap-1 p-4">
                                        {sidebarItems.map((item) => (
                                            <Link
                                                key={item.href}
                                                href={item.href}
                                                className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium hover:bg-muted"
                                            >
                                                <item.icon className="h-4 w-4" />
                                                {item.name}
                                            </Link>
                                        ))}
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
                                    <DropdownMenuItem className="text-red-500 cursor-pointer" onClick={handleLogout}>
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
                <main className="flex-1 p-6">
                    {children}
                </main>
            </div>
        </div>
    )
}
