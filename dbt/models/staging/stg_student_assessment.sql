select
    student_id::bigint as student_id,
    student_name::text as student_name,
    programme_id::bigint as programme_id,
    programme_name::text as programme_name,
    module_id::bigint as module_id,
    module_name::text as module_name,
    assessment_id::bigint as assessment_id,
    assessment_type::text as assessment_type_name,

    mark_raw::numeric(10, 5) as mark,
    mark_display::text as mark_display,

    due_date::text as due_date_raw,

    to_timestamp(date_submitted_epoch)::timestamp as submitted_at,
    to_timestamp(date_graded_epoch)::timestamp as graded_at,

    is_locked::boolean as is_locked,
    is_hidden::boolean as is_hidden,
    synced_at::timestamp as synced_at
from {{ source('raw', 'student_assessment') }}