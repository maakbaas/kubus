/**
 * The tables of the list pages (Collections, Components, Spaces, Bookmarks), not a view's items
 * tables. On a phone (styles.css, `.list-table`) such a table shows only its main column, the
 * name (still its link), and its last one, the row's icons (RowActions): one short line per row
 * instead of columns to scroll sideways to. `className={LIST_TABLE}` on the Carbon `Table`;
 * `className={LIST_MAIN}` on the main column's header and cells.
 */
export const LIST_TABLE = "list-table";
export const LIST_MAIN = "list-table__main";
