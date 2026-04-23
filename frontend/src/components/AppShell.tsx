import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  UserSquare,
  HardHat,
  CalendarCheck,
  ClipboardList,
  Users as UsersIcon,
  Building2,
  ListOrdered,
  AlertTriangle,
  Workflow,
  ShieldCheck,
  Upload,
  FileSpreadsheet,
  LogOut,
  Moon,
  Sun,
  Settings,
  Menu,
  X,
} from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useTheme } from "@/context/ThemeContext";
import { Logo } from "@/components/Logo";

type NavItem = {
  to: string;
  label: string;
  icon: ReactNode;
  visible: boolean;
};

type NavSection = {
  heading?: string;
  items: NavItem[];
};

export function AppShell({ children }: { children: ReactNode }) {
  const { claims, signOut } = useAuth();
  const { effective, toggle } = useTheme();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();
  const isAdmin = claims.appRole === "admin";

  // Auto-close the drawer on any route change (not just clicks on the sidebar
  // itself — covers back/forward nav and in-page Links too).
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  // Body scroll lock when drawer is open on mobile.
  useEffect(() => {
    if (drawerOpen) {
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = "";
      };
    }
  }, [drawerOpen]);

  const sections = useMemo<NavSection[]>(
    () => [
      {
        items: [
          {
            to: "/",
            label: "Dashboard",
            icon: <LayoutDashboard size={18} aria-hidden />,
            visible: true,
          },
        ],
      },
      {
        heading: "Staff",
        items: [
          {
            to: "/my-timesheets",
            label: "My Timesheet",
            icon: <UserSquare size={18} aria-hidden />,
            visible: true,
          },
        ],
      },
      {
        heading: "Field",
        items: [
          {
            to: "/field-timesheets",
            label: "Field Timesheets",
            icon: <HardHat size={18} aria-hidden />,
            visible: true,
          },
          {
            to: "/weekly-check",
            label: "Weekly Check",
            icon: <CalendarCheck size={18} aria-hidden />,
            visible: true,
          },
        ],
      },
      {
        heading: "Admin",
        items: [
          {
            to: "/admin/timesheets",
            label: "Manage Timesheets",
            icon: <ClipboardList size={18} aria-hidden />,
            visible: isAdmin,
          },
          {
            to: "/admin/employees",
            label: "Employees",
            icon: <UsersIcon size={18} aria-hidden />,
            visible: isAdmin,
          },
          {
            to: "/admin/projects",
            label: "Projects",
            icon: <Building2 size={18} aria-hidden />,
            visible: isAdmin,
          },
          {
            to: "/admin/codes",
            label: "Codes & Areas",
            icon: <ListOrdered size={18} aria-hidden />,
            visible: isAdmin,
          },
          {
            to: "/admin/badges",
            label: "Badge Overrides",
            icon: <AlertTriangle size={18} aria-hidden />,
            visible: isAdmin,
          },
          {
            to: "/admin/flows",
            label: "Approval Flows",
            icon: <Workflow size={18} aria-hidden />,
            visible: isAdmin,
          },
          {
            to: "/admin/users",
            label: "Users",
            icon: <ShieldCheck size={18} aria-hidden />,
            visible: isAdmin,
          },
          {
            to: "/admin/imports",
            label: "Imports",
            icon: <Upload size={18} aria-hidden />,
            visible: isAdmin,
          },
          {
            to: "/admin/settings",
            label: "Tenant Settings",
            icon: <Settings size={18} aria-hidden />,
            visible: isAdmin,
          },
        ],
      },
      {
        heading: "Reports",
        items: [
          {
            to: "/exports",
            label: "Labor Report",
            icon: <FileSpreadsheet size={18} aria-hidden />,
            visible: isAdmin,
          },
        ],
      },
    ],
    [isAdmin],
  );

  return (
    <div className="flex min-h-screen bg-canvas">
      {/* Mobile top bar (hidden on md+) */}
      <header className="md:hidden fixed top-0 inset-x-0 z-20 bg-surface border-b border-border px-3 py-2 flex items-center justify-between">
        <button
          onClick={() => setDrawerOpen(true)}
          aria-label="Open navigation"
          className="invenio-sidebar-item !px-2"
        >
          <Menu size={20} aria-hidden />
        </button>
        <Link to="/" className="flex items-center gap-2">
          <Logo variant="mark" size={28} />
          <span className="text-sm font-semibold">Timekeeping</span>
        </Link>
        <div className="w-9" aria-hidden />
      </header>

      {/* Overlay behind drawer on mobile */}
      {drawerOpen && (
        <div
          className="md:hidden fixed inset-0 z-30 bg-black/50"
          onClick={() => setDrawerOpen(false)}
          aria-hidden
        />
      )}

      <aside
        className={`invenio-sidebar ${drawerOpen ? "is-open" : ""}`}
        aria-hidden={!drawerOpen && typeof window !== "undefined" && window.innerWidth < 768}
      >
        <div className="px-4 py-4 border-b border-border flex items-center justify-between gap-2">
          <Link to="/" className="flex items-center gap-3">
            <Logo variant="mark" size={36} />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-ink-primary leading-tight">
                Timekeeping
              </p>
              <p className="text-xs text-ink-muted font-mono truncate">
                {claims.username ?? "—"} · {claims.appRole ?? "—"}
              </p>
            </div>
          </Link>
          <button
            onClick={() => setDrawerOpen(false)}
            aria-label="Close navigation"
            className="md:hidden invenio-sidebar-item !px-2"
          >
            <X size={18} aria-hidden />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-2 py-3 flex flex-col gap-4">
          {sections.map((section, i) => {
            const visible = section.items.filter((it) => it.visible);
            if (visible.length === 0) return null;
            return (
              <div key={i}>
                {section.heading && (
                  <p className="invenio-sidebar-section">{section.heading}</p>
                )}
                <ul className="flex flex-col gap-0.5">
                  {visible.map((item) => (
                    <li key={item.to}>
                      <SidebarLink {...item} />
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </nav>

        <div className="px-2 py-3 border-t border-border flex flex-col gap-0.5">
          <button
            onClick={toggle}
            className="invenio-sidebar-item w-full"
            aria-label={`Switch to ${effective === "dark" ? "light" : "dark"} mode`}
            title={`Switch to ${effective === "dark" ? "light" : "dark"} mode`}
          >
            {effective === "dark" ? (
              <Sun size={18} aria-hidden />
            ) : (
              <Moon size={18} aria-hidden />
            )}
            <span>{effective === "dark" ? "Light mode" : "Dark mode"}</span>
          </button>
          <button
            onClick={signOut}
            className="invenio-sidebar-item w-full"
          >
            <LogOut size={18} aria-hidden />
            <span>Sign out</span>
          </button>
        </div>
      </aside>

      <main className="flex-1 min-w-0 overflow-x-hidden pt-12 md:pt-0">{children}</main>
    </div>
  );
}

function SidebarLink({ to, label, icon }: NavItem) {
  const loc = useLocation();
  // Dashboard ("/") should only match exactly, not any child route.
  const isActive =
    to === "/"
      ? loc.pathname === "/"
      : loc.pathname === to || loc.pathname.startsWith(`${to}/`);
  return (
    <NavLink
      to={to}
      className={() =>
        isActive ? "invenio-sidebar-item is-active" : "invenio-sidebar-item"
      }
    >
      {icon}
      <span>{label}</span>
    </NavLink>
  );
}
