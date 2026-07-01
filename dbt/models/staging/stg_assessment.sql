select
    assessment_id::bigint as assessment_id,
    module_id::bigint as module_id,
    assessment_type_id::bigint as assessment_type_id,
    moodle_grade_item_id::bigint as moodle_grade_item_id,
    cmid::bigint as cmid,
    assessment_name::text as assessment_name,
    to_timestamp(due_date_epoch)::timestamp as due_at
    assessment_module::text as assessment_module,
    assessment_item_number::integer as assessment_item_number,
    is_course_total::boolean as is_course_total,
    last_synced_at::timestamp as last_synced_at
    to_timestamp(last_portal_access_epoch)::timestamp as last_portal_access_at
from {{ source('raw', 'assessment') }}
