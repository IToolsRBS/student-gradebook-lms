select
    assessment_id,
    module_id,
    assessment_type_id,
    assessment_name,
    is_course_total,
    due_at,

    due_at - interval '7 days' as reminder_at,
    due_at + interval '1 day' as late_reminder_at,
    due_at + interval '5 days' as late_due_at

from {{ ref('stg_assessment') }}

where due_at is not null