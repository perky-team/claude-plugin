@{{FEATURE_NAME}} {{ADDITIONAL_TAGS}}
Feature: {{FEATURE_TITLE}}
  {{FEATURE_DESCRIPTION}}

  Background:
    {{BACKGROUND_STEPS}}

  @happy-path
  Scenario: {{SCENARIO_NAME}}
    Given {{GIVEN}}
    When {{WHEN}}
    Then {{THEN}}

  @happy-path
  Scenario Outline: {{OUTLINE_NAME}}
    Given {{GIVEN}}
    When {{WHEN}}
    Then {{THEN}}

    Examples:
      | {{COLUMN_HEADERS}} |
      | {{EXAMPLE_VALUES}} |

  @error
  Scenario: {{ERROR_SCENARIO_NAME}}
    Given {{GIVEN}}
    When {{WHEN}}
    Then {{THEN}}

  @edge-case
  Scenario: {{EDGE_CASE_SCENARIO_NAME}}
    Given {{GIVEN}}
    When {{WHEN}}
    Then {{THEN}}
