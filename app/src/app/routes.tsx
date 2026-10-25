import { Navigate, Route, Routes } from "react-router";
import { BookmarksPage } from "../pages/BookmarksPage";
import { ItemPage } from "../pages/ItemPage";
import { ComponentEditorPage } from "../pages/ComponentEditorPage";
import { ComponentsPage } from "../pages/ComponentsPage";
import { NewItemPage } from "../pages/NewItemPage";
import { CollectionPage } from "../pages/CollectionPage";
import { SearchPage } from "../pages/SearchPage";
import { SpacesPage } from "../pages/SpacesPage";
import { HelpPage } from "../pages/HelpPage";
import { SettingsPage } from "../pages/SettingsPage";
import { CollectionEditorPage } from "../pages/CollectionEditorPage";
import { CollectionsPage } from "../pages/CollectionsPage";
import { NotFound } from "../ui/NotFound";

/** The app's pages. Rendered inside every workspace tab (each tab has its own router). */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/collections" replace />} />
      <Route path="/search" element={<SearchPage />} />
      <Route path="/collections" element={<CollectionsPage />} />
      <Route path="/bookmarks" element={<BookmarksPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/help" element={<HelpPage />} />
      {/* Sync's page from before the settings (tabs restored from then). */}
      <Route path="/sync" element={<Navigate to="/settings?section=sync" replace />} />
      <Route path="/spaces" element={<SpacesPage />} />
      <Route path="/components" element={<ComponentsPage />} />
      <Route path="/components/new" element={<ComponentEditorPage />} />
      <Route path="/components/:componentId" element={<ComponentEditorPage key="edit" />} />
      <Route path="/collections/new" element={<CollectionEditorPage />} />
      <Route path="/collections/:collectionId/edit" element={<CollectionEditorPage />} />
      <Route path="/collections/:collectionId/items" element={<CollectionPage />} />
      <Route path="/collections/:collectionId/items/new" element={<NewItemPage />} />
      <Route path="/collections/:collectionId/items/:itemId" element={<ItemPage />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
