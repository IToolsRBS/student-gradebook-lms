select
    m.module_id,
    m.module_code,
    m.module_name,

    a.assessment_id,
    a.assessment_name,
    at.assessment_type_name,

    tl.due_at,
    tl.reminder_at,
    tl.late_reminder_at,
    tl.late_due_at,

    count(distinct s.student_id) as total_students,

    count(distinct case
        when ss.is_submitted = true then ss.student_id
    end) as submitted_count,

    round(
        100.0 * count(distinct case
            when ss.is_submitted = true then ss.student_id
        end)
        / nullif(count(distinct s.student_id), 0),
        2
    ) as submission_rate

from {{ ref('stg_module') }} m

left join {{ ref('stg_student') }} s
    on m.programme_id = s.programme_id

left join {{ ref('stg_assessment') }} a
    on m.module_id = a.module_id

left join {{ ref('stg_assessment_type') }} at
    on a.assessment_type_id = at.assessment_type_id

left join {{ ref('int_assessment_timeline') }} tl
    on a.assessment_id = tl.assessment_id

left join {{ ref('int_student_submission_status') }} ss
    on s.student_id = ss.student_id
   and a.assessment_id = ss.assessment_id

group by
    m.module_id,
    m.module_code,
    m.module_name,
    a.assessment_id,
    a.assessment_name,
    at.assessment_type_name,
    tl.due_at,
    tl.reminder_at,
    tl.late_reminder_at,
    tl.late_due_at