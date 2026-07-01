with student_assessments as (

    select
        student_id,
        programme_id,
        module_id,
        assessment_id,
        mark,
        submitted_at,
        graded_at,
        is_locked,
        is_hidden,
        synced_at
    from {{ ref('stg_student_assessment') }}

),

assessment_timeline as (

    select
        assessment_id,
        due_at,
        reminder_at,
        late_reminder_at,
        late_due_at
    from {{ ref('int_assessment_timeline') }}

),

final as (

    select
        sa.student_id,
        sa.programme_id,
        sa.module_id,
        sa.assessment_id,

        sa.mark,
        at.due_at,
        sa.submitted_at,
        sa.graded_at,

        case
            when sa.submitted_at is not null then true
            else false
        end as is_submitted,

        case
            when sa.submitted_at is not null
             and sa.submitted_at > at.due_at
                then true
            else false
        end as is_late,

        case
            when sa.submitted_at is null
             and current_timestamp > at.due_at
                then 'Not Submitted - Overdue'

            when sa.submitted_at is null
             and current_timestamp <= at.due_at
                then 'Not Submitted - Still Open'

            when sa.submitted_at > at.due_at
                then 'Submitted Late'

            when sa.submitted_at <= at.due_at
                then 'Submitted On Time'

            else 'Unknown'
        end as submission_status,

        case
            when sa.submitted_at is not null
             and sa.submitted_at > at.due_at
                then extract(day from sa.submitted_at - at.due_at)::integer

            when sa.submitted_at is null
             and current_timestamp > at.due_at
                then extract(day from current_timestamp - at.due_at)::integer

            else 0
        end as days_late,

        sa.is_locked,
        sa.is_hidden,
        sa.synced_at

    from student_assessments sa
    left join assessment_timeline at
        on sa.assessment_id = at.assessment_id

)

select *
from final