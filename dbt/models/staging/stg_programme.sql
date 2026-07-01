select
    programme_id::bigint as programme_id,
    programme_code::text as programme_code,
    programme_name::text as programme_name,
    source_category_id::bigint as source_category_id,
    category_id::bigint as category_id,
    category::text as category_name
from {{ source('raw', 'programme') }}

