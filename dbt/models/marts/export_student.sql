select
    s.student_id,
    s.programme_name,
    s.student_number,
    s.email,
    s.full_name as "full name",
    s.last_portal_access_at as "last portal access",

    count(
        case
            when ss.submission_status = 'Not Submitted - Overdue'
                then 1
        end
    ) as overdue_assessments

from {{ ref('stg_student') }} s
left join {{ ref('int_student_submission_status') }} ss
    on s.student_id = ss.student_id

group by
    s.student_id,
    s.programme_name,
    s.student_number,
    s.email,
    s.full_name,
    s.last_portal_access_at