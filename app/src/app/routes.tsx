import { Navigate, Route, Routes } from "react-router";
import { BookmarksPage } from "../pages/BookmarksPage";
import { ObjectViewPage } from "../pages/ObjectViewPage";
import { TemplateEditorPage } from "../pages/TemplateEditorPage";
import { TemplatesPage } from "../pages/TemplatesPage";
import { NewObjectPage } from "../pages/NewObjectPage";
import { ObjectListPage } from "../pages/ObjectListPage";
import { SearchPage } from "../pages/SearchPage";
import { TypeEditorPage } from "../pages/TypeEditorPage";
import { TypesPage } from "../pages/TypesPage";
import { NotFound } from "../ui/NotFound";

/** The app's pages. Rendered inside every workspace tab (each tab has its own router). */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/types" replace />} />
      <Route path="/search" element={<SearchPage />} />
      <Route path="/types" element={<TypesPage />} />
      <Route path="/bookmarks" element={<BookmarksPage />} />
      <Route path="/templates" element={<TemplatesPage />} />
      <Route path="/templates/new" element={<TemplateEditorPage />} />
      <Route path="/templates/:templateId" element={<TemplateEditorPage key="edit" />} />
      <Route path="/types/new" element={<TypeEditorPage />} />
      <Route path="/types/:typeId/edit" element={<TypeEditorPage />} />
      <Route path="/types/:typeId/objects" element={<ObjectListPage />} />
      <Route path="/types/:typeId/objects/new" element={<NewObjectPage />} />
      <Route path="/types/:typeId/objects/:objectId" element={<ObjectViewPage />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
