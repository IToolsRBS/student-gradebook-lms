select
    module_id::bigint as module_id,
    programme_id::bigint as programme_id,
    module_code::text as module_code,
    module_name::text as module_name,
    idnumber::text as module_idnumber,

    to_timestamp(startdate_epoch)::timestamp as module_start_at,
    to_timestamp(enddate_epoch)::timestamp as module_end_at,

    visible::boolean as is_visible,
    last_synced_at::timestamp as last_synced_at
from {{ source('raw', 'module') }}

