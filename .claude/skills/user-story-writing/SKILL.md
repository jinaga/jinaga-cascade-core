---
name: user-story-writing
description: Documents the structure and template for user stories in this repository, and how to build complex systems from incremental stories, manage dependencies, and detect conflicts. Use when writing or editing user stories, reviewing story structure, planning a backlog, or checking story relationships and consistency.
---

# User Story Writing Skill

This skill defines the canonical structure for user stories in `docs/user-stories/` and provides guidance on building systems incrementally, managing dependencies, and identifying conflicts.

## When to Use This Skill

- **Writing a new user story**: Follow the template and structure so the story matches existing stories and is testable.
- **Editing an existing story**: Preserve required sections and AC format; use dependency/conflict checks when changing behavior or scope.
- **Planning or ordering work**: Use incremental-building and dependency guidance to sequence stories and split large features.
- **Reviewing consistency**: Check related stories for dependencies and conflicts before or after implementation.

## Canonical Structure

Every user story document has these sections in order:

| Section | Purpose |
|--------|--------|
| **Title** | `# User Story: [Short Name]` |
| **Story** | As a / I want to / So that (one block) |
| **Description** | Narrative context, design decisions, and scope (what is in/out). Use subsections (###) for distinct concepts. |
| **Acceptance Criteria** | **Given** / **When** / **Then** (and **And**) scenarios. Group under ### by theme; use #### for sub-groups. Number ACs (AC1, AC2 …) for traceability. |
| **Technical Notes** | Implementation hints, file locations, patterns. Optional but recommended. |
| **Related Files** | Paths to code or config this story touches. |
| **Related User Stories** | Other stories that depend on, enable, or conflict with this one. |
| **Related User Journeys** | Link to docs (e.g. Journey 3: Building a Pipeline) when applicable. |

## Story Block Format

Use exactly this phrasing (bold and line breaks):

```markdown
## Story
**As a** [role, e.g. business user]
**I want to** [capability or action]
**So that** [outcome or benefit]
```

## Acceptance Criteria Format

- Each AC is a scenario: **Given** (precondition), **When** (action or trigger), **Then** (observable outcome).
- Use **And** for multiple Given/When/Then clauses.
- Write in third person, present tense ("the user clicks", "the preview shall display").
- Prefer "shall" for mandatory behavior in Then clauses when specifying contracts.
- Number ACs (AC1, AC2, …) and optionally use sub-numbers (AC5.1, AC5.2) for clarity.

## Template and Examples

For a full section-by-section template with placeholders and notes, see [references/template-and-structure.md](references/template-and-structure.md).

Existing stories in `docs/user-stories/` (e.g. `add-data-source.md`, `configure-group-by-step.md`, `rename-property-step.md`, `group-by-names-parent-level.md`) are the source of truth for tone and depth.

## Building Complex Systems from Incremental Stories

- **Slice by user value**: Each story should deliver one testable capability (a user can do X and see Y).
- **Order by dependency**: Stories that define data shapes, APIs, or UI contracts should precede stories that use them; document this in "Related User Stories."
- **Avoid big “epic” documents**: Prefer several smaller stories that build on each other over one story that specifies an entire feature end-to-end.
- **Shared vocabulary**: Use the same terms across stories (e.g. "preview pane", "pipeline steps list", "command bar") so dependencies and conflicts are easier to spot.

For detailed guidance on incremental design, sequencing, and splitting, see [references/incremental-systems-and-dependencies.md](references/incremental-systems-and-dependencies.md).

## Managing Dependencies

- **Explicit “Related User Stories”**: List stories that must be implemented before this one (prerequisites), stories that extend or use this one, and stories that might conflict.
- **Preconditions in ACs**: Use **Given** to state dependency on prior stories (e.g. "Given a data source has been loaded" implies add-data-source is done).
- **Technical Notes**: Mention when a story depends on a particular API, type, or component so implementers know what to build first.
- **Ordering**: When in doubt, implement “foundation” stories (data model, navigation, core UI) before “feature” stories (specific steps, commands).

See [references/incremental-systems-and-dependencies.md](references/incremental-systems-and-dependencies.md) for dependency types and how to document and resolve them.

## Looking for Conflicts

- **Same UI element, different behavior**: Two stories that specify different behavior for the same screen, control, or flow (e.g. what happens when "Done" is clicked). Resolve by merging into one story or by ordering (later story overrides or refines).
- **Same term, different meaning**: Different stories using the same term for different concepts (e.g. "array name" meaning parent vs child in Group By). Align terminology and update the later story or add a clarifying story.
- **Contradictory acceptance criteria**: One story’s Then conflicts with another’s Given/Then. Compare ACs of related stories; update or split stories so criteria are consistent.
- **Scope overlap**: Two stories both specifying the same flow or component in detail. Prefer one owner story and reference it from the other, or split by user action (e.g. one story for “add step”, one for “configure step”).

Before committing a new or revised story, scan "Related User Stories" and their ACs for the above. See [references/incremental-systems-and-dependencies.md](references/incremental-systems-and-dependencies.md) for a conflict checklist and resolution strategies.
