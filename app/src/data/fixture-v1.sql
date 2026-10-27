-- A database of the first release (schema-v1.sql) with data in every table, every field kind and
-- every kind of value: what migrations.test.ts migrates to check that no data is lost. Made with
-- the first release's app; frozen like schema-v1.sql (never edited: a later release's data shapes
-- go in a fixture of their own version).

-- meta: no rows

INSERT INTO spaces (id, name, icon, position, created_at, updated_at, deleted_at) VALUES
  ('space-work', 'Work', 'Briefcase', 0, '2026-10-27T20:13:00.367Z', '2026-10-27T20:13:00.367Z', NULL);

INSERT INTO collections (id, name, plural_name, icon, description, item_views, space_ids, source, created_at, updated_at, deleted_at) VALUES
  ('collection-person', 'Person', 'People', 'User', 'People I know', NULL, NULL, NULL, '2026-10-27T20:13:00.371Z', '2026-10-27T20:13:00.371Z', NULL),
  ('collection-book', 'Book', 'Books', 'Book', '', '[{"id":"itemview-compact","name":"Compact","isDefault":false,"collapsed":{"blocks":[],"groups":{}},"layout":{"fields":["field-title","field-pages"],"editable":true,"hiddenLabels":["field-pages"],"hideEmpty":false,"blocks":[],"filters":[]}}]', '["default","space-work"]', NULL, '2026-10-27T20:13:00.374Z', '2026-10-27T20:13:00.414Z', NULL);

INSERT INTO views (id, collection_id, space_id, name, config, position, is_default, created_at, updated_at, deleted_at) VALUES
  ('e0aba22d-4c60-4e7d-b7b4-41657d3e44da', 'collection-person', 'default', 'All', '{"filters":[],"blocks":[{"id":"main","title":"","kind":"table","filters":null,"sort":[{"fieldId":"$title","direction":"asc"}],"groupBy":null,"layout":{"fields":null,"editable":true,"hiddenLabels":[],"hideEmpty":false},"collectionId":null,"options":null}],"editable":true}', 0, 0, '2026-10-27T20:13:00.371Z', '2026-10-27T20:13:00.371Z', NULL),
  ('6a877bc6-857a-403d-b924-db2491eb54a4', 'collection-book', 'default', 'All', '{"filters":[],"blocks":[{"id":"main","title":"","kind":"table","filters":null,"sort":[{"fieldId":"$title","direction":"asc"}],"groupBy":null,"layout":{"fields":null,"editable":true,"hiddenLabels":[],"hideEmpty":false},"collectionId":null,"options":null}],"editable":true}', 0, 0, '2026-10-27T20:13:00.374Z', '2026-10-27T20:13:00.374Z', NULL),
  ('view-unread', 'collection-book', 'default', 'Unread', '{"filters":[{"id":"rule-unread","fieldId":"field-read","operator":"isNotChecked","value":""}],"blocks":[{"id":"main","title":"","kind":"table","filters":null,"sort":[{"fieldId":"$title","direction":"asc"}],"groupBy":null,"layout":{"fields":null,"editable":true,"hiddenLabels":[],"hideEmpty":false},"collectionId":null,"options":null}],"editable":true,"collapsed":{"blocks":[],"groups":{}}}', 1, 1, '2026-10-27T20:13:00.410Z', '2026-10-27T20:13:00.411Z', NULL);

INSERT INTO components (id, name, description, code, output, frame_ratio, ai, created_at, updated_at, deleted_at) VALUES
  ('component-badge', 'Badge', 'A badge', '**{{ $item.Title }}**', 'markdown', NULL, 0, '2026-10-27T20:13:00.368Z', '2026-10-27T20:13:00.368Z', NULL),
  ('component-summary', 'Summary', '', 'Summarize {{ $item.Title }}', 'string', NULL, 1, '2026-10-27T20:13:00.369Z', '2026-10-27T20:13:00.369Z', NULL);

INSERT INTO fields (id, collection_id, name, kind, target_collection_id, component_id, choice_filter, toggle_icon, strike_through, code, output, frame_ratio, source_column, position, created_at, updated_at, deleted_at) VALUES
  ('field-name', 'collection-person', 'Name', 'string', NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, 0, '2026-10-27T20:13:00.371Z', '2026-10-27T20:13:00.371Z', NULL),
  ('field-title', 'collection-book', 'Title', 'string', NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, 0, '2026-10-27T20:13:00.374Z', '2026-10-27T20:13:00.374Z', NULL),
  ('field-notes', 'collection-book', 'Notes', 'markdown', NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, 1, '2026-10-27T20:13:00.374Z', '2026-10-27T20:13:00.374Z', NULL),
  ('field-pages', 'collection-book', 'Pages', 'number', NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, 2, '2026-10-27T20:13:00.374Z', '2026-10-27T20:13:00.374Z', NULL),
  ('field-published', 'collection-book', 'Published', 'date', NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, 3, '2026-10-27T20:13:00.374Z', '2026-10-27T20:13:00.374Z', NULL),
  ('field-finished', 'collection-book', 'Finished', 'datetime', NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, 4, '2026-10-27T20:13:00.374Z', '2026-10-27T20:13:00.374Z', NULL),
  ('field-read', 'collection-book', 'Read', 'checkbox', NULL, NULL, NULL, 'Star', 0, NULL, NULL, NULL, NULL, 5, '2026-10-27T20:13:00.374Z', '2026-10-27T20:13:00.374Z', NULL),
  ('field-cover', 'collection-book', 'Cover', 'image', NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, 6, '2026-10-27T20:13:00.374Z', '2026-10-27T20:13:00.374Z', NULL),
  ('field-author', 'collection-book', 'Author', 'item', 'collection-person', NULL, '[{"id":"rule-writers","fieldId":"field-name","operator":"contains","value":"Herbert"}]', NULL, 0, NULL, NULL, NULL, NULL, 7, '2026-10-27T20:13:00.374Z', '2026-10-27T20:13:00.374Z', NULL),
  ('field-tags', 'collection-book', 'Tags', 'string_list', NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, 8, '2026-10-27T20:13:00.374Z', '2026-10-27T20:13:00.374Z', NULL),
  ('field-todo', 'collection-book', 'To do', 'checklist', NULL, NULL, NULL, NULL, 1, NULL, NULL, NULL, NULL, 9, '2026-10-27T20:13:00.374Z', '2026-10-27T20:13:00.374Z', NULL),
  ('field-also', 'collection-book', 'See also', 'item_list', 'collection-book', NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, 10, '2026-10-27T20:13:00.374Z', '2026-10-27T20:13:00.374Z', NULL),
  ('field-badge', 'collection-book', 'Badge', 'component', NULL, 'component-badge', NULL, NULL, 0, NULL, NULL, NULL, NULL, 11, '2026-10-27T20:13:00.374Z', '2026-10-27T20:13:00.374Z', NULL),
  ('field-local', 'collection-book', 'Local', 'component', NULL, NULL, NULL, NULL, 0, '{{ $item.Pages * 2 }}', 'number', NULL, NULL, 12, '2026-10-27T20:13:00.374Z', '2026-10-27T20:13:00.374Z', NULL),
  ('field-summary', 'collection-book', 'Summary', 'ai', NULL, 'component-summary', NULL, NULL, 0, NULL, 'string', NULL, NULL, 13, '2026-10-27T20:13:00.374Z', '2026-10-27T20:13:00.374Z', NULL),
  ('field-html', 'collection-book', 'Html', 'html', NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, 14, '2026-10-27T20:13:00.374Z', '2026-10-27T20:13:00.374Z', NULL);

INSERT INTO items (id, collection_id, space_id, item_view_id, created_at, updated_at, deleted_at) VALUES
  ('item-herbert', 'collection-person', 'default', NULL, '2026-10-27T20:13:00.395Z', '2026-10-27T20:13:00.395Z', NULL),
  ('item-dune', 'collection-book', 'default', 'itemview-compact', '2026-10-27T20:13:00.396Z', '2026-10-27T20:13:00.415Z', NULL),
  ('item-emma', 'collection-book', 'space-work', NULL, '2026-10-27T20:13:00.397Z', '2026-10-27T20:13:00.397Z', NULL),
  ('30b85bcb-fbda-4b52-85ff-7b180fa3e8be', 'collection-book', 'default', NULL, '2026-10-27T20:13:00.407Z', '2026-10-27T20:13:00.408Z', '2026-10-27T20:13:00.408Z');

INSERT INTO files (id, mime, size, data, created_at, unused_since) VALUES
  ('e06cc5dc61902f1ec01216ae3298216b218ad494ca253a85557ed4e44a23994b', 'image/png', 11, x'636f766572206279746573', '2026-10-27T20:13:00.386Z', NULL),
  ('05eeec2d70845694d3ba89ad9e1c34b6b4d806275c3c63b84241a40ae4591ca4', 'image/webp', 5, x'7468756d62', '2026-10-27T20:13:00.387Z', NULL);

INSERT INTO thumbnails (file_id, thumb_id, created_at) VALUES
  ('e06cc5dc61902f1ec01216ae3298216b218ad494ca253a85557ed4e44a23994b', '05eeec2d70845694d3ba89ad9e1c34b6b4d806275c3c63b84241a40ae4591ca4', '2026-10-27T20:13:00.394Z');

INSERT INTO field_values (item_id, field_id, value_text, value_number, value_date, value_datetime, value_bool, value_ref, value_file, value_json, updated_at) VALUES
  ('item-herbert', 'field-name', 'Frank Herbert', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-10-27T20:13:00.395Z'),
  ('item-dune', 'field-title', 'Dune', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-10-27T20:13:00.396Z'),
  ('item-dune', 'field-notes', '# Notes

A *desert* planet. ![](files/e06cc5dc61902f1ec01216ae3298216b218ad494ca253a85557ed4e44a23994b)', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-10-27T20:13:00.396Z'),
  ('item-dune', 'field-pages', NULL, 412.5, NULL, NULL, NULL, NULL, NULL, NULL, '2026-10-27T20:13:00.396Z'),
  ('item-dune', 'field-published', NULL, NULL, '1965-08-01', NULL, NULL, NULL, NULL, NULL, '2026-10-27T20:13:00.396Z'),
  ('item-dune', 'field-finished', NULL, NULL, NULL, '2026-03-01T10:00:00.000Z', NULL, NULL, NULL, NULL, '2026-10-27T20:13:00.396Z'),
  ('item-dune', 'field-read', NULL, NULL, NULL, NULL, 1, NULL, NULL, NULL, '2026-10-27T20:13:00.396Z'),
  ('item-dune', 'field-cover', NULL, NULL, NULL, NULL, NULL, NULL, 'e06cc5dc61902f1ec01216ae3298216b218ad494ca253a85557ed4e44a23994b', NULL, '2026-10-27T20:13:00.396Z'),
  ('item-dune', 'field-author', NULL, NULL, NULL, NULL, NULL, 'item-herbert', NULL, NULL, '2026-10-27T20:13:00.396Z'),
  ('item-dune', 'field-tags', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '["sf","classic"]', '2026-10-27T20:13:00.396Z'),
  ('item-dune', 'field-todo', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '["[x] read","[ ] reread"]', '2026-10-27T20:13:00.396Z'),
  ('item-dune', 'field-also', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '["item-emma"]', '2026-10-27T20:13:00.396Z'),
  ('item-dune', 'field-html', '<b>bold</b>', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-10-27T20:13:00.396Z'),
  ('item-emma', 'field-title', 'Emma', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-10-27T20:13:00.397Z'),
  ('item-emma', 'field-read', NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, '2026-10-27T20:13:00.397Z'),
  ('item-dune', 'field-summary', 'A desert epic', NULL, NULL, NULL, NULL, NULL, NULL, '{"hash":"hash-1"}', '2026-10-27T20:13:00.405Z'),
  ('30b85bcb-fbda-4b52-85ff-7b180fa3e8be', 'field-title', 'Deleted one', NULL, NULL, NULL, NULL, NULL, NULL, NULL, '2026-10-27T20:13:00.407Z');

INSERT INTO bookmarks (id, kind, collection_id, space_id, target_id, label, position, created_at, updated_at, deleted_at) VALUES
  ('ed1d2589-f446-45f3-81c3-f7ef67a6feb2', 'item', 'collection-book', 'default', 'item-dune', 'Dune', 0, '2026-10-27T20:13:00.412Z', '2026-10-27T20:13:00.412Z', NULL),
  ('323f53a7-fed3-4992-8ce5-48c3781ca094', 'view', 'collection-book', 'default', 'view-unread', 'Unread books', 1, '2026-10-27T20:13:00.413Z', '2026-10-27T20:13:00.413Z', NULL);

