// Locators and steps the suites share (suites are plain scripts sharing one scope with lib/: a name defined
// here can't be declared again in a suite file). `t` is the test's context.

/** The open toolbar popover's panel (the last one when several are open). */
const toolbarPanel = (t) => t.page.locator(".toolbar-popover__panel:visible").last();
/** The open popover (a toolbar panel, a menu's host, a block's settings). */
const shownPopover = (t) => t.page.locator(".cds--popover--open").last();
/** The visible dialog. */
const shownModal = (t) => t.page.locator(".cds--modal.is-visible");

/** A Carbon dropdown / combo box / multi-select inside `scope`, by its title (its label's text; a multi-select with a selection adds its count for screen readers after it). */
const dropdownOf = (t, scope, title) =>
  scope.locator(".cds--dropdown__wrapper, .cds--combo-box, .cds--list-box__wrapper, .cds--multi-select__wrapper").filter({ has: t.page.locator(".cds--label", { hasText: new RegExp(`^${title}(Total items selected|$)`) }) }).first();
/** The options of the open menu, as texts. */
const menuOptions = async (t) => (await t.page.getByRole("option").filter({ visible: true }).allInnerTexts()).map((s) => s.trim());
/** Opens the dropdown `title` inside `scope` and picks the option with that text. */
async function pickOption(t, scope, title, option) {
  await dropdownOf(t, scope, title).locator(".cds--list-box__field").first().click();
  await t.settle(80);
  await t.page.getByRole("option", { name: option, exact: true }).filter({ visible: true }).first().click();
  await t.settle(80);
}
