with assessment_summary as (

    select *
    FROM {{ ref('int_module_assessment_summary') }}

),

final as (

    select
        module_id,
        module_name,
        module_code,
        max(total_students) as total_students,

        max(case when lower(assessment_name) like '%assignment 1%' then reminder_at end) as "Assignment 1 reminder (-7)",
        max(case when lower(assessment_name) like '%assignment 1%' then due_at end) as "Assignment 1 due date",
        max(case when lower(assessment_name) like '%assignment 1%' then late_reminder_at end) as "Late assignment 1 submission reminder (+1)",
        max(case when lower(assessment_name) like '%assignment 1%' then late_due_at end) as "Late submission assignment 1 due date (+5)",
        max(case when lower(assessment_name) like '%assignment 1%' then submitted_count end) as "No. of assignment 1 submitted",
        max(case when lower(assessment_name) like '%assignment 1%' then submission_rate end) as "Assignment 1 % submitted",

        max(case when lower(assessment_name) like '%quiz 1%' then reminder_at end) as "Quiz 1 reminder (-7)",
        max(case when lower(assessment_name) like '%quiz 1%' then due_at end) as "Quiz 1 due date",
        max(case when lower(assessment_name) like '%quiz 1%' then submitted_count end) as "No. of quiz 1 submitted",
        max(case when lower(assessment_name) like '%quiz 1%' then submission_rate end) as "Quiz 1 % submitted",

        max(case when lower(assessment_name) like '%test 1%' then reminder_at end) as "Test 1 reminder (-7)",
        max(case when lower(assessment_name) like '%test 1%' then due_at end) as "Test 1 due date",
        max(case when lower(assessment_name) like '%test 1%' then submitted_count end) as "No. of test 1 submitted",
        max(case when lower(assessment_name) like '%test 1%' then submission_rate end) as "Test 1 % submitted",

        max(case when lower(assessment_name) like '%main exam%' then due_at end) as "Main exam date",
        max(case when lower(assessment_name) like '%supp%' then due_at end) as "Supp exam date"

    from assessment_summary

    group by
        module_id,
        module_name,
        module_code

)

select *
from final