import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { AppNav, reportLocation, useChatCommands, useHostChanges, useHostNavigate, type AppNavItem } from "@clawnify/app/client";
import { api, type Course } from "./api";
import { OverviewPage } from "./routes/overview";
import { CoursesPage } from "./routes/courses";
import { CoursePage } from "./routes/course";
import { PeoplePage } from "./routes/people";
import { RecordsPage } from "./routes/records";
import { PresentersPage } from "./routes/presenters";
import { SettingsPage } from "./routes/settings";

export function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const [courses, setCourses] = useState<Course[]>([]);

  const loadCourses = useCallback(async () => {
    try {
      setCourses((await api.courses()).courses);
    } catch {
      /* the pages show their own errors */
    }
  }, []);

  useEffect(() => void loadCourses(), [loadCourses]);
  useHostNavigate((path) => navigate(path));
  useHostChanges(() => void loadCourses());
  useEffect(() => reportLocation(location.pathname + location.search), [location.pathname, location.search]);
  useChatCommands([
    { id: "draft-course", label: "Course from a document", prompt: "Create a training course from this document and draft its outline:" },
    { id: "overdue", label: "Who is overdue", prompt: "Who is overdue on their training? Group them by course." },
    { id: "remind", label: "Remind overdue people", prompt: "Draft a short reminder email to everyone overdue on their training, with their own link." },
    { id: "audit", label: "Training record for an audit", prompt: "Summarise the training record for an audit: each course, its current version, how many completed, and who is still open." },
  ]);

  const groups = useMemo(() => {
    const top: AppNavItem[] = [
      { id: "home", label: "Overview", href: "/", home: true },
      { id: "courses", label: "Courses", href: "/courses", icon: "book-open", color: "violet" },
      { id: "people", label: "People", href: "/people", icon: "users", color: "sky" },
      { id: "records", label: "Records", href: "/records", icon: "clipboard-list", color: "green" },
      { id: "presenters", label: "Presenters", href: "/presenters", icon: "video", color: "pink" },
      { id: "settings", label: "Settings", href: "/settings", icon: "settings" },
    ];
    const recent: AppNavItem[] = courses.slice(0, 8).map((c) => ({
      id: `course:${c.id}`,
      label: c.title,
      href: `/courses/${c.id}`,
      icon: "book-open",
      color: "violet",
      ...(c.counts.overdue ? { count: c.counts.overdue } : {}),
    }));
    return recent.length ? [{ items: top }, { label: "Courses", items: recent }] : [{ items: top }];
  }, [courses]);

  const path = location.pathname;
  const courseMatch = path.match(/^\/courses\/([^/]+)/);
  const active = courseMatch ? `course:${courseMatch[1]}` : (["courses", "people", "records", "presenters", "settings"].find((s) => path.startsWith(`/${s}`)) ?? "home");

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      <AppNav title="OpenAcademy" icon="book-open" groups={groups} active={active} onNavigate={(item) => item.href && navigate(item.href)} />
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/courses" element={<CoursesPage onChanged={loadCourses} />} />
          <Route path="/courses/:id" element={<CoursePage onChanged={loadCourses} />} />
          <Route path="/courses/:id/:tab" element={<CoursePage onChanged={loadCourses} />} />
          <Route path="/people" element={<PeoplePage />} />
          <Route path="/records" element={<RecordsPage />} />
          <Route path="/presenters" element={<PresentersPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
