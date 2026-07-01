select
    s.student_number as "student number",
    s.full_name as student_name,
    s.programme_name,
    m.module_name,
    sa.assessment_type_name as assessment_type,
    sa.due_at as due_date,
    sa.mark_display,
    sa.submitted_at as date_submitted,

    ss.submission_status,
    ss.days_late

from {{ ref('stg_student_assessment') }} sa
left join {{ ref('stg_student') }} s
    on sa.student_id = s.student_id
left join {{ ref('stg_module') }} m
    on sa.module_id = m.module_id
left join {{ ref('int_student_submission_status') }} ss
    on sa.student_id = ss.student_id
   and sa.assessment_id = ss.assessment_id