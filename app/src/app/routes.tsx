import { Suspense } from "react";
import { Route, Routes } from "react-router";
import { CollectionEditorPage, ComponentEditorPage, ComponentsPage, HelpPage, RemotesPage, SettingsPage, SpacesPage } from "./lazyParts";
import { BookmarksPage } from "../pages/BookmarksPage";
import { HomePage } from "../pages/HomePage";
import { ItemPage } from "../pages/ItemPage";
import { NewItemPage } from "../pages/NewItemPage";
import { CollectionPage } from "../pages/CollectionPage";
import { SearchPage } from "../pages/SearchPage";
import { CollectionsPage } from "../pages/CollectionsPage";
import { DashboardPage } from "../pages/DashboardPage";
import { DashboardsPage } from "../pages/DashboardsPage";
import { NotFound } from "../ui/NotFound";

/** The app's pages. Rendered inside every workspace tab (each tab has its own router). */
export function AppRoutes() {
  // A page not loaded yet (lazyParts.tsx) draws nothing meanwhile; navigating to one keeps the page before (a transition) until it is there.
  return (
    <Suspense fallback={null}>
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/search" element={<SearchPage />} />
      <Route path="/collections" element={<CollectionsPage />} />
      <Route path="/bookmarks" element={<BookmarksPage />} />
      <Route path="/dashboards" element={<DashboardsPage />} />
      <Route path="/dashboards/:dashboardId" element={<DashboardPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/help" element={<HelpPage />} />
      <Route path="/spaces" element={<SpacesPage />} />
      <Route path="/components" element={<ComponentsPage />} />
      <Route path="/components/new" element={<ComponentEditorPage />} />
      <Route path="/components/:componentId" element={<ComponentEditorPage key="edit" />} />
      <Route path="/collections/new" element={<CollectionEditorPage />} />
      <Route path="/collections/:collectionId/edit" element={<CollectionEditorPage />} />
      {/* Remote collections are listed, added and edited under Remotes (the same editor). */}
      <Route path="/remotes" element={<RemotesPage />} />
      <Route path="/remotes/new" element={<CollectionEditorPage remote />} />
      <Route path="/remotes/:collectionId/edit" element={<CollectionEditorPage remote />} />
      <Route path="/collections/:collectionId/items" element={<CollectionPage />} />
      <Route path="/collections/:collectionId/items/new" element={<NewItemPage />} />
      <Route path="/collections/:collectionId/items/:itemId" element={<ItemPage />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
    </Suspense>
  );
}
